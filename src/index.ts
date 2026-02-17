#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs/promises";
import { createReadStream } from "fs";
import * as path from "path";
import * as readline from "readline";
import ignore, { Ignore } from "ignore";

// MCP 서버 인스턴스 생성
const server = new McpServer({
    name: "markdown-explorer-mcp",
    version: "4.0.0",
});

// ============================================
// 상수 정의
// ============================================

const MARKDOWN_EXTENSIONS = [".md", ".mdx", ".markdown"];

/**
 * Base 디렉토리 설정
 * 환경변수 MARKDOWN_BASE_DIR이 설정되면 상대 경로는 이 디렉토리를 기준으로 해석됩니다.
 * 세미콜론(;)으로 구분하여 여러 디렉토리를 지정할 수 있습니다.
 * 예: "C:\Vault1;C:\Vault2;C:\Vault3"
 * 첫 번째 경로가 상대 경로 해석의 기본 기준이 됩니다.
 * 설정되지 않으면 MCP 서버의 현재 작업 디렉토리(cwd)를 사용합니다.
 */
const BASE_DIRS: string[] = process.env.MARKDOWN_BASE_DIR
    ? process.env.MARKDOWN_BASE_DIR.split(";").map(d => path.resolve(d.trim())).filter(d => d.length > 0)
    : [process.cwd()];

/** 첫 번째 BASE_DIR (상대 경로 해석 기준) */
const PRIMARY_BASE_DIR = BASE_DIRS[0];

// ============================================
// 유틸리티 함수
// ============================================

/**
 * 입력 경로를 절대 경로로 정규화합니다.
 * - 절대 경로: 그대로 사용
 * - 상대 경로: BASE_DIR을 기준으로 해석
 */
function normalizePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
        return path.resolve(inputPath);
    }
    return path.resolve(PRIMARY_BASE_DIR, inputPath);
}

/**
 * 경로가 허용된 BASE_DIRS 중 하나의 내부에 있는지 검증합니다.
 * 보안: 모든 허용 디렉토리 외부 접근을 차단합니다.
 */
function isPathWithinBaseDir(normalizedPath: string): boolean {
    const resolvedPath = path.resolve(normalizedPath);
    const pathLower = resolvedPath.toLowerCase();

    return BASE_DIRS.some(baseDir => {
        const baseLower = path.resolve(baseDir).toLowerCase();
        // Windows에서 대소문자 무시
        return pathLower === baseLower || pathLower.startsWith(baseLower + path.sep);
    });
}

/**
 * 경로를 정규화하고 BASE_DIR 내부인지 검증합니다.
 * BASE_DIR 외부면 null을 반환합니다.
 */
function normalizeAndValidatePath(inputPath: string): string | null {
    const normalized = normalizePath(inputPath);
    if (!isPathWithinBaseDir(normalized)) {
        return null;
    }
    return normalized;
}

/**
 * BASE_DIR 외부 접근 시 에러 응답 생성
 */
function accessDeniedError(inputPath: string) {
    const allowedDirs = BASE_DIRS.join(", ");
    return createErrorResponse(
        `접근이 거부되었습니다: "${inputPath}"는 허용된 디렉토리(${allowedDirs}) 외부에 있습니다.`
    );
}

async function exists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

function formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMarkdownFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return MARKDOWN_EXTENSIONS.includes(ext);
}

/**
 * 에러 응답 생성 헬퍼
 */
function createErrorResponse(message: string) {
    return {
        content: [{ type: "text" as const, text: `오류: ${message}` }],
        isError: true,
    };
}

function pathNotFoundError(normalizedPath: string) {
    return createErrorResponse(`경로가 존재하지 않습니다: ${normalizedPath}`);
}

function notDirectoryError(normalizedPath: string) {
    return createErrorResponse(`디렉토리가 아닙니다: ${normalizedPath}`);
}

function notMarkdownError(normalizedPath: string) {
    return createErrorResponse(`마크다운 파일이 아닙니다: ${normalizedPath}`);
}

/**
 * LLM이 여러 JSON 객체를 연결하여 보낸 경우 첫 번째 query만 추출.
 * 예: '{"query":"A"}{"query":"B"}' → 'A'
 * 정상 입력은 그대로 반환.
 */
function sanitizeQuery(input: string): string {
    const trimmed = input.trim();
    // 패턴: {"query":"..."}...{ 형태 감지
    if (trimmed.includes('"}') && trimmed.includes('{"')) {
        const multiJsonPattern = /^\s*\{[^}]*"query"\s*:\s*"([^"]+)"[^}]*\}/;
        const match = trimmed.match(multiJsonPattern);
        if (match) {
            return match[1];
        }
    }
    return trimmed;
}

/**
 * .gitignore 파일들을 읽어서 ignore 인스턴스 생성
 */
async function loadGitignore(directory: string): Promise<Ignore> {
    const ig = ignore();
    ig.add(["node_modules", ".git", ".svn", "__pycache__", "dist", "build", ".DS_Store", ".obsidian"]);

    let currentDir = directory;
    const gitignoreFiles: string[] = [];

    while (currentDir !== path.dirname(currentDir)) {
        const gitignorePath = path.join(currentDir, ".gitignore");
        if (await exists(gitignorePath)) {
            gitignoreFiles.unshift(gitignorePath);
        }
        currentDir = path.dirname(currentDir);
    }

    for (const gitignorePath of gitignoreFiles) {
        try {
            const content = await fs.readFile(gitignorePath, "utf8");
            ig.add(content);
        } catch {
            // 읽기 실패 시 무시
        }
    }

    return ig;
}

/**
 * YAML 파서 캐싱 (동적 import 오버헤드 제거)
 */
let yamlParser: { parse: (str: string) => Record<string, unknown> } | null = null;

async function getYamlParser() {
    if (!yamlParser) {
        const yamlModule = await import("yaml");
        yamlParser = yamlModule.default || yamlModule;
    }
    return yamlParser;
}

/**
 * YAML 프론트매터 파싱
 */
async function parseFrontmatter(content: string): Promise<Record<string, unknown> | null> {
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
    const match = content.match(frontmatterRegex);

    if (!match) return null;

    try {
        const yaml = await getYamlParser();
        return yaml.parse(match[1]) || {};
    } catch {
        return null;
    }
}

/**
 * 프론트매터 이후의 본문만 추출
 */
function extractBody(content: string): string {
    const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
    return content.replace(frontmatterRegex, "").trim();
}



// ============================================
// 도구 1: get_directory_tree
// ============================================

server.tool(
    "get_directory_tree",
    "Show the directory structure as a tree (does not read file contents). For overview only, not search. Example: {\"path\":\"docs\",\"depth\":2}.",
    {
        path: z.string().optional().default(".").describe("Root directory path for the tree. Defaults to base directory if omitted."),
        depth: z.number().optional().default(3).describe("Maximum depth to display (integer >= 1). Larger values increase output size/tokens (default 3)."),
        markdownOnly: z.boolean().optional().default(true).describe("Show only markdown files (.md/.mdx/.markdown) and directories. Default: true."),
        showHidden: z.boolean().optional().default(false).describe("Include hidden entries (names starting with .)."),
        respectGitignore: z.boolean().optional().default(true).describe("Apply .gitignore rules to exclude paths."),
    },
    async ({ path: dirPath, depth, markdownOnly, showHidden, respectGitignore }) => {
        try {
            const validatedPath = normalizeAndValidatePath(dirPath);
            if (validatedPath === null) {
                return accessDeniedError(dirPath);
            }
            const normalizedPath = validatedPath; // 타입 좁히기 적용된 변수

            if (!(await exists(normalizedPath))) {
                return pathNotFoundError(normalizedPath);
            }

            const stats = await fs.stat(normalizedPath);
            if (!stats.isDirectory()) {
                return notDirectoryError(normalizedPath);
            }

            if (!Number.isInteger(depth) || depth < 1) {
                return createErrorResponse("depth must be an integer >= 1.");
            }

            const lines: string[] = [];
            const ig = respectGitignore ? await loadGitignore(normalizedPath) : null;

            async function buildTree(dir: string, prefix: string, currentDepth: number): Promise<void> {
                if (currentDepth > depth) return;

                try {
                    let entries = await fs.readdir(dir, { withFileTypes: true });

                    if (!showHidden) {
                        entries = entries.filter((e) => !e.name.startsWith("."));
                    }

                    if (ig) {
                        entries = entries.filter((e) => {
                            const relativePath = path.relative(normalizedPath, path.join(dir, e.name));
                            return !ig.ignores(relativePath);
                        });
                    }

                    // 마크다운만 표시 옵션
                    if (markdownOnly) {
                        entries = entries.filter((e) =>
                            e.isDirectory() || isMarkdownFile(e.name)
                        );
                    }

                    entries.sort((a, b) => {
                        if (a.isDirectory() !== b.isDirectory()) {
                            return a.isDirectory() ? -1 : 1;
                        }
                        return a.name.localeCompare(b.name);
                    });

                    for (let i = 0; i < entries.length; i++) {
                        const entry = entries[i];
                        const isLast = i === entries.length - 1;
                        const connector = isLast ? "└── " : "├── ";
                        const icon = entry.isDirectory() ? "[D] " : (isMarkdownFile(entry.name) ? "" : "[?] ");

                        lines.push(`${prefix}${connector}${icon}${entry.name}`);

                        if (entry.isDirectory()) {
                            const newPrefix = prefix + (isLast ? "    " : "│   ");
                            await buildTree(path.join(dir, entry.name), newPrefix, currentDepth + 1);
                        }
                    }
                } catch {
                    // 접근 권한 없는 디렉토리는 무시
                }
            }

            lines.push(`${path.basename(normalizedPath)}/`);
            await buildTree(normalizedPath, "", 1);

            return {
                content: [{
                    type: "text",
                    text: lines.join("\n"),
                }],
            };
        } catch (error) {
            return createErrorResponse(error instanceof Error ? error.message : String(error));
        }
    }
);

// ============================================
// 도구 2: list_directory
// ============================================

server.tool(
    "list_directory",
    "List immediate contents of a directory (one level only). Returns folders and markdown files with sizes. Use this tool to explore folder structures step by step. When you see subdirectories in the results, call this tool again on them to explore deeper. Example: {\"path\":\"papers\"} → see subfolders → {\"path\":\"papers/paper_A\"} → see files.",
    {
        path: z.string().optional().default(".").describe("Directory path to list. Defaults to base directory."),
        markdownOnly: z.boolean().optional().default(true).describe("Show only markdown files and directories. Set false to see all files."),
        showHidden: z.boolean().optional().default(false).describe("Include hidden entries (names starting with .)."),
        respectGitignore: z.boolean().optional().default(true).describe("Apply .gitignore rules to exclude paths."),
    },
    async ({ path: dirPath, markdownOnly, showHidden, respectGitignore }) => {
        try {
            const validatedPath = normalizeAndValidatePath(dirPath);
            if (validatedPath === null) {
                return accessDeniedError(dirPath);
            }
            const normalizedPath = validatedPath;

            if (!(await exists(normalizedPath))) {
                return pathNotFoundError(normalizedPath);
            }

            const stats = await fs.stat(normalizedPath);
            if (!stats.isDirectory()) {
                return notDirectoryError(normalizedPath);
            }

            const ig = respectGitignore ? await loadGitignore(normalizedPath) : null;

            let entries = await fs.readdir(normalizedPath, { withFileTypes: true });

            if (!showHidden) {
                entries = entries.filter((e) => !e.name.startsWith("."));
            }

            if (ig) {
                entries = entries.filter((e) => {
                    const relativePath = path.relative(normalizedPath, path.join(normalizedPath, e.name));
                    return !ig.ignores(relativePath);
                });
            }

            if (markdownOnly) {
                entries = entries.filter((e) =>
                    e.isDirectory() || isMarkdownFile(e.name)
                );
            }

            // 디렉토리 먼저, 그다음 파일 (이름순 정렬)
            entries.sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) {
                    return a.isDirectory() ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });

            if (entries.length === 0) {
                const typeNote = markdownOnly ? " (markdownOnly=true)" : "";
                return {
                    content: [{
                        type: "text",
                        text: `디렉토리가 비어 있습니다${typeNote}: ${normalizedPath}`,
                    }],
                };
            }

            const lines: string[] = [];
            let dirCount = 0;
            let fileCount = 0;

            for (const entry of entries) {
                const fullPath = path.join(normalizedPath, entry.name);

                if (entry.isDirectory()) {
                    // 하위 항목 수 카운트 (1단계만)
                    let childCount = 0;
                    try {
                        const children = await fs.readdir(fullPath);
                        childCount = children.length;
                    } catch {
                        // 읽기 실패 시 무시
                    }
                    lines.push(`  [DIR] ${entry.name}/ (${childCount} items)`);
                    dirCount++;
                } else {
                    try {
                        const fileStat = await fs.stat(fullPath);
                        lines.push(`  [FILE] ${entry.name} (${formatFileSize(fileStat.size)})`);
                    } catch {
                        lines.push(`  [FILE] ${entry.name}`);
                    }
                    fileCount++;
                }
            }

            let header = `${normalizedPath}\n`;
            header += `${dirCount} directories, ${fileCount} files\n`;

            if (dirCount > 0) {
                header += `\nTip: Call list_directory on any subdirectory to explore deeper.\n`;
            }

            return {
                content: [{
                    type: "text",
                    text: header + "\n" + lines.join("\n"),
                }],
            };
        } catch (error) {
            return createErrorResponse(error instanceof Error ? error.message : String(error));
        }
    }
);

// ============================================
// 도구 3: search_markdown (통합 검색)
// ============================================

server.tool(
    "search_markdown",
    "Unified search for markdown files. Searches filename, tags, AND content in ONE call. IMPORTANT: Provide exactly ONE query string per call. For multiple searches, call this tool multiple times. Example: {\"query\":\"project\"} or {\"query\":\"회의\", \"tag\":\"work\"}.",
    {
        query: z.string().describe("Search query - searches filename, frontmatter tags, and file content simultaneously."),
        tag: z.string().optional().describe("Filter by tag in frontmatter (substring match, case-insensitive)."),
        filenamePattern: z.string().optional().describe("Filename glob pattern filter (*, ? supported). Example: \"*회의*\"."),
        directory: z.string().optional().default(".").describe("Root directory to search. Defaults to base directory."),
        maxResults: z.number().optional().default(10).describe("Maximum total results to return (integer > 0)."),
        respectGitignore: z.boolean().optional().default(true).describe("Apply .gitignore rules."),
    },
    async ({ query, tag, filenamePattern, directory, maxResults, respectGitignore }) => {
        try {
            const validatedPath = normalizeAndValidatePath(directory);
            if (validatedPath === null) {
                return accessDeniedError(directory);
            }
            const normalizedPath = validatedPath;

            if (!(await exists(normalizedPath))) {
                return pathNotFoundError(normalizedPath);
            }

            if (!query || query.trim().length === 0) {
                return createErrorResponse("query must be a non-empty string.");
            }

            const sanitizedQuery = sanitizeQuery(query);
            const queryLower = sanitizedQuery.toLowerCase();
            const tagLower = tag?.toLowerCase();
            const ig = respectGitignore ? await loadGitignore(normalizedPath) : null;

            // 파일명 패턴 정규식 (옵션)
            let filenameRegex: RegExp | null = null;
            if (filenamePattern) {
                const regexPattern = filenamePattern
                    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                    .replace(/\*/g, ".*")
                    .replace(/\?/g, ".");
                filenameRegex = new RegExp(`^${regexPattern}$`, "i");
            }

            interface SearchResult {
                path: string;
                matchTypes: ("filename" | "tag" | "content")[];
                tags?: string[];
                contentMatches?: { line: number; text: string }[];
                score: number;
            }

            const results: SearchResult[] = [];

            async function searchFile(filePath: string, fileName: string): Promise<void> {
                // 파일명 패턴 필터
                if (filenameRegex && !filenameRegex.test(fileName)) {
                    return;
                }

                const result: SearchResult = {
                    path: filePath,
                    matchTypes: [],
                    score: 0,
                };

                // 1. 파일명 매칭
                if (fileName.toLowerCase().includes(queryLower)) {
                    result.matchTypes.push("filename");
                    result.score += 10;
                }

                // 2. 프론트매터 및 내용 검색 (처음 8KB만 읽어서 성능 최적화)
                try {
                    const fileHandle = await fs.open(filePath, "r");
                    const buffer = Buffer.alloc(8192);
                    const { bytesRead } = await fileHandle.read(buffer, 0, 8192, 0);
                    await fileHandle.close();
                    const content = buffer.toString("utf8", 0, bytesRead);

                    // 태그 검색 및 필터
                    const metadata = await parseFrontmatter(content);
                    if (metadata?.tags && Array.isArray(metadata.tags)) {
                        // 태그 필터가 있으면 필터 먼저 적용
                        if (tagLower) {
                            const hasTag = metadata.tags.some(t =>
                                String(t).toLowerCase().includes(tagLower)
                            );
                            if (!hasTag) return; // 태그 필터 미통과 시 제외
                        }

                        // 쿼리로 태그 매칭
                        const matchedTags = metadata.tags.filter(t =>
                            String(t).toLowerCase().includes(queryLower)
                        );
                        if (matchedTags.length > 0) {
                            result.matchTypes.push("tag");
                            result.tags = matchedTags.map(String);
                            result.score += 8;
                        } else if (tagLower) {
                            // 태그 필터는 통과했지만 쿼리 매칭은 아님 - 태그 정보만 저장
                            result.tags = metadata.tags.filter(t =>
                                String(t).toLowerCase().includes(tagLower)
                            ).map(String);
                        }
                    } else if (tagLower) {
                        // 태그 필터가 있는데 파일에 태그가 없으면 제외
                        return;
                    }

                    // 내용 검색 (첫 3개 매칭만)
                    const lines = content.split(/\r?\n/);
                    const contentMatches: { line: number; text: string }[] = [];
                    for (let i = 0; i < lines.length && contentMatches.length < 3; i++) {
                        if (lines[i].toLowerCase().includes(queryLower)) {
                            contentMatches.push({
                                line: i + 1,
                                text: lines[i].trim().substring(0, 100),
                            });
                        }
                    }
                    if (contentMatches.length > 0) {
                        result.matchTypes.push("content");
                        result.contentMatches = contentMatches;
                        result.score += contentMatches.length * 2;
                    }
                } catch {
                    // 파일 읽기 실패 시 무시
                }

                if (result.matchTypes.length > 0) {
                    results.push(result);
                }
            }

            async function walkDir(dir: string): Promise<void> {
                if (results.length >= maxResults * 2) return; // 여유있게 수집 후 정렬

                try {
                    const entries = await fs.readdir(dir, { withFileTypes: true });

                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        const relativePath = path.relative(normalizedPath, fullPath);

                        if (ig && ig.ignores(relativePath)) continue;

                        if (entry.isDirectory()) {
                            await walkDir(fullPath);
                        } else if (entry.isFile() && isMarkdownFile(entry.name)) {
                            await searchFile(fullPath, entry.name);
                        }
                    }
                } catch {
                    // 접근 권한 없는 디렉토리는 무시
                }
            }

            await walkDir(normalizedPath);

            if (results.length === 0) {
                // 결과 없을 때 대안 제시
                let suggestions = `"${query}" 검색 결과 없음\n\n`;
                suggestions += `제안:\n`;
                suggestions += `  • 다른 검색어 시도\n`;
                suggestions += `  • 전체 구조 확인: get_directory_tree로 볼트 구조 파악\n`;

                return {
                    content: [{ type: "text", text: suggestions }],
                };
            }

            // 점수순 정렬 후 maxResults만큼 반환
            results.sort((a, b) => b.score - a.score);
            const topResults = results.slice(0, maxResults);

            // 결과 포맷팅
            const filenameMatches = topResults.filter(r => r.matchTypes.includes("filename"));
            const tagMatches = topResults.filter(r => r.matchTypes.includes("tag"));
            const contentMatches = topResults.filter(r => r.matchTypes.includes("content"));

            let output = `"${query}" 검색 결과 (${topResults.length}건):\n\n`;

            if (filenameMatches.length > 0) {
                output += `[파일명] (${filenameMatches.length}건):\n`;
                filenameMatches.forEach(r => {
                    output += `  • ${r.path}\n`;
                });
                output += "\n";
            }

            if (tagMatches.length > 0) {
                output += `[태그] (${tagMatches.length}건):\n`;
                tagMatches.forEach(r => {
                    output += `  • ${r.path} (tags: [${r.tags?.join(", ")}])\n`;
                });
                output += "\n";
            }

            if (contentMatches.length > 0) {
                output += `[내용] (${contentMatches.length}건):\n`;
                contentMatches.forEach(r => {
                    r.contentMatches?.slice(0, 1).forEach(m => {
                        output += `  • ${r.path}:L${m.line}: "${m.text.substring(0, 60)}${m.text.length > 60 ? "..." : ""}"\n`;
                    });
                });
            }

            return {
                content: [{ type: "text", text: output.trim() }],
            };
        } catch (error) {
            return createErrorResponse(error instanceof Error ? error.message : String(error));
        }
    }
);



// ============================================
// 도구 4: read_markdown_toc
// ============================================

server.tool(
    "read_markdown_toc",
    "Extract headers (H1-H6) to build a table of contents. Ignores headers inside code blocks. Example: {\"path\":\"README.md\",\"maxLevel\":3}.",
    {
        path: z.string().describe("Markdown file path (must be a file)."),
        maxLevel: z.number().optional().default(6).describe("Maximum header level to include (1-6)."),
    },
    async ({ path: filePath, maxLevel }) => {
        try {
            const validatedPath = normalizeAndValidatePath(filePath);
            if (validatedPath === null) {
                return accessDeniedError(filePath);
            }
            const normalizedPath = validatedPath;

            if (!(await exists(normalizedPath))) {
                return pathNotFoundError(normalizedPath);
            }

            if (!isMarkdownFile(normalizedPath)) {
                return notMarkdownError(normalizedPath);
            }

            if (!Number.isInteger(maxLevel) || maxLevel < 1 || maxLevel > 6) {
                return createErrorResponse("maxLevel must be an integer between 1 and 6.");
            }

            const content = await fs.readFile(normalizedPath, "utf8");
            const lines = content.split(/\r?\n/);

            interface TocEntry {
                level: number;
                text: string;
                line: number;
            }

            const toc: TocEntry[] = [];
            // 앞 공백 허용 (Obsidian 호환)
            const headerRegex = /^\s*(#{1,6})\s+(.+)$/;
            let inCodeBlock = false;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                if (line.startsWith("```")) {
                    inCodeBlock = !inCodeBlock;
                    continue;
                }
                if (inCodeBlock) continue;

                const match = line.match(headerRegex);
                if (match) {
                    const level = match[1].length;
                    if (level <= maxLevel) {
                        toc.push({
                            level,
                            text: match[2].trim(),
                            line: i + 1,
                        });
                    }
                }
            }

            if (toc.length === 0) {
                return {
                    content: [{ type: "text", text: "헤더를 찾을 수 없습니다." }],
                };
            }

            const output = toc.map(entry => {
                const indent = "  ".repeat(entry.level - 1);
                const prefix = "#".repeat(entry.level);
                return `${indent}${prefix} ${entry.text} (L${entry.line})`;
            }).join("\n");

            return {
                content: [{
                    type: "text",
                    text: `목차 (${toc.length}개 헤더):\n\n${output}`,
                }],
            };
        } catch (error) {
            return createErrorResponse(error instanceof Error ? error.message : String(error));
        }
    }
);

// ============================================
// 도구 5: read_markdown_section
// ============================================

server.tool(
    "read_markdown_section",
    "Read only the section under a specific header. Supports: (1) direct path + header, (2) SEARCH mode - find the header across all files when you don't know which file contains it. Example: {\"path\":\"README.md\",\"header\":\"Installation\"} or {\"header\":\"Installation\"}.",
    {
        path: z.string().optional().describe("Markdown file path. If omitted, searches all files for the header."),
        header: z.string().describe("Header text to find (non-empty). Leading '#' is ignored."),
        directory: z.string().optional().default(".").describe("Root directory for search when path is omitted."),
        includeSubsections: z.boolean().optional().default(true).describe("If true, include subsections."),
        maxFiles: z.number().optional().default(3).describe("Max files to search when path is omitted (1-10)."),
    },
    async ({ path: filePath, header, directory, includeSubsections, maxFiles }) => {
        try {
            const headerText = header.replace(/^#+\s*/, "").trim();
            if (!headerText) {
                return createErrorResponse("header must be a non-empty string.");
            }

            const headerRegex = /^\s*(#{1,6})\s+(.+)$/;

            // 단일 파일에서 섹션 추출 함수
            async function extractSection(normalizedPath: string): Promise<{ found: boolean; content: string }> {
                const content = await fs.readFile(normalizedPath, "utf8");
                const lines = content.split(/\r?\n/);

                let targetLevel = 0;
                let startLine = -1;
                let endLine = lines.length;
                let inCodeBlock = false;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];

                    if (line.startsWith("```")) {
                        inCodeBlock = !inCodeBlock;
                        continue;
                    }
                    if (inCodeBlock) continue;

                    const match = line.match(headerRegex);
                    if (match) {
                        const level = match[1].length;
                        const text = match[2].trim();

                        if (startLine === -1) {
                            if (text.toLowerCase() === headerText.toLowerCase()) {
                                startLine = i;
                                targetLevel = level;
                            }
                        } else {
                            if (includeSubsections) {
                                if (level <= targetLevel) {
                                    endLine = i;
                                    break;
                                }
                            } else {
                                endLine = i;
                                break;
                            }
                        }
                    }
                }

                if (startLine === -1) {
                    return { found: false, content: "" };
                }

                const sectionLines = lines.slice(startLine, endLine);
                const sectionContent = sectionLines.join("\n").trim();
                return {
                    found: true,
                    content: `--- ${normalizedPath} | 섹션: ${lines[startLine]} (L${startLine + 1}-${endLine}) ---\n\n${sectionContent}`,
                };
            }

            // path가 주어진 경우: 기존 단일 파일 모드
            if (filePath) {
                const validatedPath = normalizeAndValidatePath(filePath);
                if (validatedPath === null) {
                    return accessDeniedError(filePath);
                }
                const normalizedPath = validatedPath;

                if (!(await exists(normalizedPath))) {
                    return pathNotFoundError(normalizedPath);
                }

                if (!isMarkdownFile(normalizedPath)) {
                    return notMarkdownError(normalizedPath);
                }

                const result = await extractSection(normalizedPath);
                if (!result.found) {
                    return {
                        content: [{
                            type: "text",
                            text: `헤더 "${headerText}"를 찾을 수 없습니다.\n\npath 없이 header만 지정하면 전체 파일에서 검색합니다.`,
                        }],
                        isError: true,
                    };
                }

                return {
                    content: [{ type: "text", text: result.content }],
                };
            }

            // path가 없는 경우: 전체 디렉토리에서 검색
            const normalizedDir = normalizePath(directory);
            if (!(await exists(normalizedDir))) {
                return pathNotFoundError(normalizedDir);
            }

            const ig = await loadGitignore(normalizedDir);
            const foundFiles: string[] = [];
            const limitedMax = Math.min(Math.max(1, maxFiles), 10);

            async function searchForHeader(dir: string): Promise<void> {
                if (foundFiles.length >= limitedMax * 3) return; // 여유있게 수집

                try {
                    const entries = await fs.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        const relativePath = path.relative(normalizedDir, fullPath);

                        if (ig.ignores(relativePath)) continue;

                        if (entry.isDirectory()) {
                            await searchForHeader(fullPath);
                        } else if (entry.isFile() && isMarkdownFile(entry.name)) {
                            // 파일 내용에서 헤더 빠르게 검색
                            try {
                                const content = await fs.readFile(fullPath, "utf8");
                                if (content.toLowerCase().includes(headerText.toLowerCase())) {
                                    // 실제 헤더인지 확인
                                    const lines = content.split(/\r?\n/);
                                    for (const line of lines) {
                                        const match = line.match(headerRegex);
                                        if (match && match[2].trim().toLowerCase() === headerText.toLowerCase()) {
                                            foundFiles.push(fullPath);
                                            break;
                                        }
                                    }
                                }
                            } catch {
                                // 파일 읽기 실패 시 무시
                            }
                        }
                    }
                } catch {
                    // 접근 권한 없는 디렉토리는 무시
                }
            }

            await searchForHeader(normalizedDir);

            if (foundFiles.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `헤더 "${headerText}"를 포함하는 파일을 찾을 수 없습니다.\n\nsearch_markdown 도구로 관련 파일을 먼저 찾아보세요.`,
                    }],
                    isError: true,
                };
            }

            const results: string[] = [];
            for (const file of foundFiles.slice(0, limitedMax)) {
                try {
                    const result = await extractSection(file);
                    if (result.found) {
                        results.push(result.content);
                    }
                } catch {
                    // 추출 실패 시 무시
                }
            }

            if (results.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `헤더 "${headerText}"를 찾았지만 섹션 추출에 실패했습니다.`,
                    }],
                    isError: true,
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `"${headerText}" 섹션 (${results.length}개 파일에서 발견):\n\n${results.join("\n\n")}`,
                }],
            };
        } catch (error) {
            return createErrorResponse(error instanceof Error ? error.message : String(error));
        }
    }
);

// ============================================
// 도구 6: read_markdown_full
// ============================================

server.tool(
    "read_markdown_full",
    "Read entire markdown file(s) and return frontmatter + body. Supports: (1) direct path, (2) multiple paths, (3) SEARCH mode. IMPORTANT: Provide exactly ONE query string per call. Example: {\"path\":\"README.md\"} or {\"query\":\"개발일지\"}.",
    {
        path: z.string().optional().describe("Single file path. Use 'path', 'paths', or 'query'."),
        paths: z.array(z.string()).optional().describe("Array of file paths."),
        query: z.string().optional().describe("Search query to find and read files. Use when you don't know the exact path."),
        directory: z.string().optional().default(".").describe("Root directory for query search."),
        maxFiles: z.number().optional().default(3).describe("Max files to read when using query (1-10)."),
    },
    async ({ path: singlePath, paths: multiplePaths, query, directory, maxFiles }) => {
        try {
            let filePaths: string[] = [];

            // query 모드: 검색 후 상위 N개 파일 읽기
            if (query) {
                if (singlePath || multiplePaths) {
                    return createErrorResponse("When using 'query', do not provide 'path' or 'paths'.");
                }

                const normalizedDir = normalizePath(directory);
                if (!(await exists(normalizedDir))) {
                    return pathNotFoundError(normalizedDir);
                }

                const sanitizedQuery = sanitizeQuery(query);
                const queryLower = sanitizedQuery.toLowerCase();
                const ig = await loadGitignore(normalizedDir);

                interface FileScore {
                    path: string;
                    score: number;
                }
                const scored: FileScore[] = [];

                async function searchFiles(dir: string): Promise<void> {
                    try {
                        const entries = await fs.readdir(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            const relativePath = path.relative(normalizedDir, fullPath);

                            if (ig.ignores(relativePath)) continue;

                            if (entry.isDirectory()) {
                                await searchFiles(fullPath);
                            } else if (entry.isFile() && isMarkdownFile(entry.name)) {
                                let score = 0;

                                // 파일명 매칭
                                if (entry.name.toLowerCase().includes(queryLower)) {
                                    score += 10;
                                }

                                // 내용 미리보기 (첫 4KB)
                                try {
                                    const fileHandle = await fs.open(fullPath, "r");
                                    const buffer = Buffer.alloc(4096);
                                    const { bytesRead } = await fileHandle.read(buffer, 0, 4096, 0);
                                    await fileHandle.close();
                                    const content = buffer.toString("utf8", 0, bytesRead).toLowerCase();

                                    if (content.includes(queryLower)) {
                                        score += 5;
                                    }
                                } catch {
                                    // 파일 읽기 실패 시 무시
                                }

                                if (score > 0) {
                                    scored.push({ path: fullPath, score });
                                }
                            }
                        }
                    } catch {
                        // 접근 권한 없는 디렉토리는 무시
                    }
                }

                await searchFiles(normalizedDir);

                if (scored.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: `"${query}" 검색 결과 없음\n\nsearch_markdown 도구로 먼저 파일을 찾아보세요.`,
                        }],
                    };
                }

                scored.sort((a, b) => b.score - a.score);
                const limitedMax = Math.min(Math.max(1, maxFiles), 10);
                filePaths = scored.slice(0, limitedMax).map(s => s.path);

            } else {
                // 기존 path/paths 모드
                if (singlePath && multiplePaths) {
                    return createErrorResponse("Provide either 'path' or 'paths', not both.");
                }
                if (multiplePaths && multiplePaths.length === 0) {
                    return createErrorResponse("'paths' must contain at least one path.");
                }
                filePaths = multiplePaths || (singlePath ? [singlePath] : []);

                if (filePaths.length === 0) {
                    return createErrorResponse("path, paths, 또는 query 중 하나를 지정해야 합니다.");
                }
            }

            const results: string[] = [];

            for (const filePath of filePaths) {
                const validatedPath = normalizeAndValidatePath(filePath);
                if (validatedPath === null) {
                    results.push(`--- ${filePath} ---\n[오류: 접근이 거부되었습니다 (BASE_DIR 외부)]\n`);
                    continue;
                }
                const normalizedPath = validatedPath;

                if (!(await exists(normalizedPath))) {
                    results.push(`--- ${normalizedPath} ---\n[오류: 파일이 존재하지 않습니다]\n`);
                    continue;
                }

                if (!isMarkdownFile(normalizedPath)) {
                    results.push(`--- ${normalizedPath} ---\n[오류: 마크다운 파일이 아닙니다]\n`);
                    continue;
                }

                try {
                    const content = await fs.readFile(normalizedPath, "utf8");
                    const metadata = await parseFrontmatter(content);
                    const body = extractBody(content);

                    let output = `--- ${normalizedPath} ---\n\n`;

                    if (metadata && Object.keys(metadata).length > 0) {
                        output += `[메타데이터]\n${JSON.stringify(metadata, null, 2)}\n\n`;
                    }

                    output += `[본문]\n${body}\n`;
                    results.push(output);
                } catch (error) {
                    results.push(`--- ${normalizedPath} ---\n[오류: ${error instanceof Error ? error.message : String(error)}]\n`);
                }
            }

            return {
                content: [{
                    type: "text",
                    text: results.join("\n"),
                }],
            };
        } catch (error) {
            return createErrorResponse(error instanceof Error ? error.message : String(error));
        }
    }
);

// ============================================
// 도구 7: get_linked_files
// ============================================

server.tool(
    "get_linked_files",
    "Extract links, wiki links, images, and embeds from a markdown file. Optionally check whether targets exist. Example: {\"path\":\"README.md\",\"type\":\"markdown\"}.",
    {
        path: z.string().describe("Markdown file path."),
        type: z.enum(["all", "markdown", "image", "external", "embed"]).optional().default("all").describe("Filter: all | markdown | image | external | embed."),
        checkExists: z.boolean().optional().default(false).describe("If true, verify link targets exist (relative paths are resolved from the file; slower)."),
    },
    async ({ path: filePath, type, checkExists }) => {
        try {
            const validatedPath = normalizeAndValidatePath(filePath);
            if (validatedPath === null) {
                return accessDeniedError(filePath);
            }
            const normalizedPath = validatedPath;

            if (!(await exists(normalizedPath))) {
                return pathNotFoundError(normalizedPath);
            }

            if (!isMarkdownFile(normalizedPath)) {
                return notMarkdownError(normalizedPath);
            }

            const content = await fs.readFile(normalizedPath, "utf8");
            const fileDir = path.dirname(normalizedPath);

            interface LinkInfo {
                type: "markdown" | "image" | "external" | "embed";
                target: string;
                text?: string;
                line: number;
                exists?: boolean;
                resolvedPath?: string;
            }

            const links: LinkInfo[] = [];
            const lines = content.split(/\r?\n/);
            let inCodeBlock = false;

            // negative lookbehind로 이미지 링크 제외 (중복 카운트 방지)
            const markdownLinkRegex = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
            const wikiLinkRegex = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
            const embedRegex = /!\[\[([^\]]+)\]\]/g;
            const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;

            const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp"];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const lineNum = i + 1;

                if (line.startsWith("```")) {
                    inCodeBlock = !inCodeBlock;
                    continue;
                }
                if (inCodeBlock) continue;

                let match;

                // 일반 마크다운 링크
                while ((match = markdownLinkRegex.exec(line)) !== null) {
                    const target = match[2];
                    const isExternal = /^https?:\/\//.test(target);
                    const ext = path.extname(target).toLowerCase();
                    const isImage = imageExtensions.includes(ext);

                    let linkType: LinkInfo["type"];
                    if (isExternal) linkType = "external";
                    else if (isImage) linkType = "image";
                    else linkType = "markdown";

                    if (type === "all" || type === linkType) {
                        const linkInfo: LinkInfo = {
                            type: linkType,
                            target,
                            text: match[1] || undefined,
                            line: lineNum,
                        };

                        if (checkExists && !isExternal) {
                            const resolvedPath = path.resolve(fileDir, target);
                            linkInfo.resolvedPath = resolvedPath;
                            linkInfo.exists = await exists(resolvedPath);
                        }

                        links.push(linkInfo);
                    }
                }

                // 위키 링크
                while ((match = wikiLinkRegex.exec(line)) !== null) {
                    if (type === "all" || type === "markdown") {
                        const target = match[1];
                        const linkInfo: LinkInfo = {
                            type: "markdown",
                            target,
                            text: match[2] || undefined,
                            line: lineNum,
                        };

                        if (checkExists) {
                            // 위키 링크는 .md 확장자가 없을 수 있음
                            const possiblePath = path.resolve(fileDir, target.endsWith(".md") ? target : `${target}.md`);
                            linkInfo.resolvedPath = possiblePath;
                            linkInfo.exists = await exists(possiblePath);
                        }

                        links.push(linkInfo);
                    }
                }

                // 임베드
                while ((match = embedRegex.exec(line)) !== null) {
                    if (type === "all" || type === "embed") {
                        const target = match[1];
                        const linkInfo: LinkInfo = {
                            type: "embed",
                            target,
                            line: lineNum,
                        };

                        if (checkExists) {
                            const resolvedPath = path.resolve(fileDir, target);
                            linkInfo.resolvedPath = resolvedPath;
                            linkInfo.exists = await exists(resolvedPath);
                        }

                        links.push(linkInfo);
                    }
                }

                // 이미지
                while ((match = imageRegex.exec(line)) !== null) {
                    const target = match[2];
                    const isExternal = /^https?:\/\//.test(target);

                    if (type === "all" || type === "image" || (isExternal && type === "external")) {
                        const linkInfo: LinkInfo = {
                            type: isExternal ? "external" : "image",
                            target,
                            text: match[1] || undefined,
                            line: lineNum,
                        };

                        if (checkExists && !isExternal) {
                            const resolvedPath = path.resolve(fileDir, target);
                            linkInfo.resolvedPath = resolvedPath;
                            linkInfo.exists = await exists(resolvedPath);
                        }

                        links.push(linkInfo);
                    }
                }

                markdownLinkRegex.lastIndex = 0;
                wikiLinkRegex.lastIndex = 0;
                embedRegex.lastIndex = 0;
                imageRegex.lastIndex = 0;
            }

            if (links.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: type === "all"
                            ? "링크를 찾을 수 없습니다."
                            : `"${type}" 타입의 링크를 찾을 수 없습니다.`,
                    }],
                };
            }

            // 타입별로 그룹화
            const grouped = {
                markdown: links.filter(l => l.type === "markdown"),
                image: links.filter(l => l.type === "image"),
                external: links.filter(l => l.type === "external"),
                embed: links.filter(l => l.type === "embed"),
            };

            let output = `링크 (${links.length}개 발견):\n\n`;

            const formatLink = (l: LinkInfo) => {
                const status = checkExists ? (l.exists ? "[O]" : "[X]") : "•";
                const displayTarget = l.type === "markdown" && !l.target.includes("/") ? `[[${l.target}]]` : l.target;
                return `  ${status} L${l.line}: ${displayTarget}${l.text ? ` (${l.text})` : ""}`;
            };

            if (grouped.markdown.length > 0) {
                output += `[마크다운] (${grouped.markdown.length}개):\n`;
                grouped.markdown.forEach(l => output += formatLink(l) + "\n");
                output += "\n";
            }

            if (grouped.image.length > 0) {
                output += `[이미지] (${grouped.image.length}개):\n`;
                grouped.image.forEach(l => output += formatLink(l) + "\n");
                output += "\n";
            }

            if (grouped.external.length > 0) {
                output += `[외부] (${grouped.external.length}개):\n`;
                grouped.external.forEach(l => output += formatLink(l) + "\n");
                output += "\n";
            }

            if (grouped.embed.length > 0) {
                output += `[임베드] (${grouped.embed.length}개):\n`;
                grouped.embed.forEach(l => output += formatLink(l) + "\n");
            }

            return {
                content: [{
                    type: "text",
                    text: output.trim(),
                }],
            };
        } catch (error) {
            return createErrorResponse(error instanceof Error ? error.message : String(error));
        }
    }
);

// ============================================
// 리소스 1: vault-context (Vault 컨텍스트)
// ============================================

server.resource(
    "vault-context",
    "mcp://markdown-explorer-mcp/vault-context",
    async (uri) => {
        try {
            // 1. 최상위 폴더 구조 (모든 BASE_DIRS에서 수집)
            const topLevelDirs: string[] = [];
            const topLevelFiles: string[] = [];

            for (const baseDir of BASE_DIRS) {
                try {
                    const ig = await loadGitignore(baseDir);
                    const entries = await fs.readdir(baseDir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.name.startsWith(".")) continue;
                        if (ig.ignores(entry.name)) continue;

                        if (entry.isDirectory()) {
                            topLevelDirs.push(`[${path.basename(baseDir)}] ${entry.name}`);
                        } else if (isMarkdownFile(entry.name)) {
                            topLevelFiles.push(`[${path.basename(baseDir)}] ${entry.name}`);
                        }
                    }
                } catch {
                    // 디렉토리 읽기 실패 시 무시
                }
            }

            // 2. 최근 수정된 파일 (최대 10개)
            interface FileInfo {
                path: string;
                mtime: Date;
            }
            const recentFiles: FileInfo[] = [];

            async function collectRecentFiles(baseDir: string, dir: string, ig: Ignore, depth: number): Promise<void> {
                if (depth > 5 || recentFiles.length >= 50) return;

                try {
                    const entries = await fs.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        const relativePath = path.relative(baseDir, fullPath);

                        if (entry.name.startsWith(".")) continue;
                        if (ig.ignores(relativePath)) continue;

                        if (entry.isDirectory()) {
                            await collectRecentFiles(baseDir, fullPath, ig, depth + 1);
                        } else if (isMarkdownFile(entry.name)) {
                            try {
                                const stats = await fs.stat(fullPath);
                                recentFiles.push({ path: `[${path.basename(baseDir)}] ${relativePath}`, mtime: stats.mtime });
                            } catch {
                                // 파일 stat 실패 시 무시
                            }
                        }
                    }
                } catch {
                    // 디렉토리 읽기 실패 시 무시
                }
            }

            for (const baseDir of BASE_DIRS) {
                const ig = await loadGitignore(baseDir);
                await collectRecentFiles(baseDir, baseDir, ig, 0);
            }
            recentFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
            const topRecentFiles = recentFiles.slice(0, 10).map(f => f.path);

            // 3. 인기 태그 (최대 15개)
            const tagCounts = new Map<string, number>();

            async function collectTags(baseDir: string, dir: string, ig: Ignore, depth: number): Promise<void> {
                if (depth > 5 || tagCounts.size >= 100) return;

                try {
                    const entries = await fs.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        const relativePath = path.relative(baseDir, fullPath);

                        if (entry.name.startsWith(".")) continue;
                        if (ig.ignores(relativePath)) continue;

                        if (entry.isDirectory()) {
                            await collectTags(baseDir, fullPath, ig, depth + 1);
                        } else if (isMarkdownFile(entry.name)) {
                            try {
                                const fileHandle = await fs.open(fullPath, "r");
                                const buffer = Buffer.alloc(2048);
                                const { bytesRead } = await fileHandle.read(buffer, 0, 2048, 0);
                                await fileHandle.close();
                                const content = buffer.toString("utf8", 0, bytesRead);

                                const metadata = await parseFrontmatter(content);
                                if (metadata?.tags && Array.isArray(metadata.tags)) {
                                    for (const tag of metadata.tags) {
                                        const tagStr = String(tag).toLowerCase();
                                        tagCounts.set(tagStr, (tagCounts.get(tagStr) || 0) + 1);
                                    }
                                }
                            } catch {
                                // 파일 읽기 실패 시 무시
                            }
                        }
                    }
                } catch {
                    // 디렉토리 읽기 실패 시 무시
                }
            }

            for (const baseDir of BASE_DIRS) {
                const ig = await loadGitignore(baseDir);
                await collectTags(baseDir, baseDir, ig, 0);
            }
            const topTags = Array.from(tagCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 15)
                .map(([tag, count]) => ({ tag, count }));

            // 4. 통계
            const stats = {
                totalFolders: topLevelDirs.length,
                totalRecentFiles: recentFiles.length,
                totalTags: tagCounts.size,
            };

            return {
                contents: [{
                    uri: uri.href,
                    mimeType: "application/json",
                    text: JSON.stringify({
                        baseDirs: BASE_DIRS,
                        structure: {
                            folders: topLevelDirs.slice(0, 20),
                            rootFiles: topLevelFiles.slice(0, 10),
                        },
                        recentFiles: topRecentFiles,
                        topTags,
                        stats,
                        tips: [
                            "smart_search: 파일명/태그/내용을 한 번에 검색",
                            "read_markdown_full(query='...'): 검색 후 바로 읽기",
                            "read_markdown_section(header='...'): 전체에서 헤더 검색",
                        ],
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: "text/plain",
                    text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                }],
            };
        }
    }
);

// ============================================
// 리소스 2: 서버 정보
// ============================================

server.resource(
    "server-info",
    "mcp://markdown-explorer-mcp/info",
    async (uri) => {
        return {
            contents: [
                {
                    uri: uri.href,
                    mimeType: "application/json",
                    text: JSON.stringify({
                        name: "markdown-explorer-mcp",
                        version: "5.0.0",
                        description: "마크다운 전용 파일 탐색 MCP 서버",
                        baseDirs: BASE_DIRS,
                        features: [
                            "통합 검색 (smart_search) - 파일명/태그/내용 동시 검색",
                            "검색 후 바로 읽기 (query 파라미터)",
                            "전체 헤더 검색 (read_markdown_section)",
                            "프론트매터 태그 기반 검색",
                            "목차(TOC) 추출",
                            "섹션별 부분 읽기",
                            "링크 추출 및 존재 확인",
                            "복수 파일 일괄 읽기",
                            "vault-context 리소스",
                        ],
                        tools: [
                            "smart_search (추천: 통합 검색)",
                            "list_directory",
                            "get_directory_tree",
                            "search_markdown_files",
                            "search_text_in_markdown",
                            "read_markdown_toc",
                            "read_markdown_section",
                            "read_markdown_full",
                            "get_linked_files",
                        ],
                        resources: [
                            "vault-context (vault 구조/최근 파일/태그)",
                            "server-info",
                        ],
                    }, null, 2),
                },
            ],
        };
    }
);

// ============================================
// 서버 시작
// ============================================

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`Markdown Explorer MCP 서버 v5.0.0 시작 (BASE_DIRS: ${BASE_DIRS.join(", ")})`);
}

main().catch((error) => {
    console.error("서버 시작 실패:", error);
    process.exit(1);
});
