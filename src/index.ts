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

// ============================================
// 유틸리티 함수
// ============================================

function normalizePath(inputPath: string): string {
    return path.resolve(inputPath);
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
// 도구 1: list_directory
// ============================================

server.tool(
    "list_directory",
    "List only the immediate files and subfolders in a directory (non-recursive). Not a search. For search, use 'search_markdown_files' or 'search_text_in_markdown'. Example: {\"path\":\"docs\"}.",
    {
        path: z.string().describe("Directory path to list (must exist and be a directory). No glob/search; file paths are not allowed. Example: \"docs\"."),
    },
    async ({ path: dirPath }) => {
        try {
            const normalizedPath = normalizePath(dirPath);

            if (!(await exists(normalizedPath))) {
                return pathNotFoundError(normalizedPath);
            }

            const stats = await fs.stat(normalizedPath);
            if (!stats.isDirectory()) {
                return notDirectoryError(normalizedPath);
            }

            const entries = await fs.readdir(normalizedPath, { withFileTypes: true });

            const items = await Promise.all(
                entries.map(async (entry) => {
                    const fullPath = path.join(normalizedPath, entry.name);
                    const itemStats = await fs.stat(fullPath).catch(() => null);

                    return {
                        name: entry.name,
                        type: entry.isDirectory() ? "directory" : "file",
                        isMarkdown: entry.isFile() ? isMarkdownFile(entry.name) : undefined,
                        size: itemStats && !entry.isDirectory() ? formatFileSize(itemStats.size) : undefined,
                        modified: itemStats ? itemStats.mtime.toISOString() : undefined,
                    };
                })
            );

            items.sort((a, b) => {
                if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({ path: normalizedPath, items }, null, 2),
                }],
            };
        } catch (error) {
            return createErrorResponse(error instanceof Error ? error.message : String(error));
        }
    }
);

// ============================================
// 도구 2: get_directory_tree
// ============================================

server.tool(
    "get_directory_tree",
    "Show the directory structure as a tree (does not read file contents). For overview only, not search. Example: {\"path\":\"docs\",\"depth\":2}.",
    {
        path: z.string().describe("Root directory path for the tree (must be a directory)."),
        depth: z.number().optional().default(3).describe("Maximum depth to display (integer >= 1). Larger values increase output size/tokens (default 3)."),
        markdownOnly: z.boolean().optional().default(false).describe("If true, show only markdown files (.md/.mdx/.markdown) while keeping directories."),
        showHidden: z.boolean().optional().default(false).describe("Include hidden entries (names starting with .)."),
        respectGitignore: z.boolean().optional().default(true).describe("Apply .gitignore rules to exclude paths."),
    },
    async ({ path: dirPath, depth, markdownOnly, showHidden, respectGitignore }) => {
        try {
            const normalizedPath = normalizePath(dirPath);

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
                        const icon = entry.isDirectory() ? "📁 " : (isMarkdownFile(entry.name) ? "📝 " : "📄 ");

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

            lines.push(`📁 ${path.basename(normalizedPath)}/`);
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
// 도구 3: search_markdown_files
// ============================================

server.tool(
    "search_markdown_files",
    "Find markdown files by filename pattern and frontmatter (tags/properties). Does not search file contents; use 'search_text_in_markdown' for content search. Example: {\"directory\":\"notes\",\"pattern\":\"*.md\",\"tag\":\"project\"}.",
    {
        directory: z.string().describe("Root directory to search (must be a directory)."),
        pattern: z.string().optional().default("*").describe("Filename glob pattern (*, ? supported, case-insensitive). Default '*'."),
        tag: z.string().optional().describe("Tag to match in frontmatter 'tags' array (substring match, case-insensitive)."),
        property: z.string().optional().describe("Frontmatter key name (use together with value)."),
        value: z.string().optional().describe("Value to match for the property (substring match, case-insensitive)."),
        maxDepth: z.number().optional().default(10).describe("Maximum directory depth to search (integer >= 0; large values are slower)."),
        respectGitignore: z.boolean().optional().default(true).describe("Apply .gitignore rules."),
    },
    async ({ directory, pattern, tag, property, value, maxDepth, respectGitignore }) => {
        try {
            const normalizedPath = normalizePath(directory);

            if (!(await exists(normalizedPath))) {
                return pathNotFoundError(normalizedPath);
            }

            const stats = await fs.stat(normalizedPath);
            if (!stats.isDirectory()) {
                return notDirectoryError(normalizedPath);
            }

            if ((property && !value) || (!property && value)) {
                return createErrorResponse("Both 'property' and 'value' must be provided together.");
            }

            if (pattern.trim().length == 0) {
                return createErrorResponse("pattern must be a non-empty glob string.");
            }

            if (!Number.isInteger(maxDepth) || maxDepth < 0) {
                return createErrorResponse("maxDepth must be an integer >= 0.");
            }

            const results: { path: string; metadata?: Record<string, unknown> }[] = [];
            const ig = respectGitignore ? await loadGitignore(normalizedPath) : null;

            // 파일명 패턴을 정규식으로 변환
            const regexPattern = pattern
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, ".*")
                .replace(/\?/g, ".");
            const regex = new RegExp(`^${regexPattern}$`, "i");

            async function searchDir(dir: string, depth: number): Promise<void> {
                if (depth > maxDepth) return;

                try {
                    const entries = await fs.readdir(dir, { withFileTypes: true });

                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        const relativePath = path.relative(normalizedPath, fullPath);

                        if (ig && ig.ignores(relativePath)) continue;

                        if (entry.isDirectory()) {
                            await searchDir(fullPath, depth + 1);
                        } else if (entry.isFile() && isMarkdownFile(entry.name)) {
                            // 파일명 패턴 매칭
                            if (!regex.test(entry.name)) continue;

                            // 태그/속성 필터링이 필요한 경우
                            if (tag || (property && value)) {
                                try {
                                    // 프론트매터는 파일 시작 부분에만 있으므로 처음 4KB만 읽음 (성능 최적화)
                                    const fileHandle = await fs.open(fullPath, "r");
                                    const buffer = Buffer.alloc(4096);
                                    const { bytesRead } = await fileHandle.read(buffer, 0, 4096, 0);
                                    await fileHandle.close();
                                    const content = buffer.toString("utf8", 0, bytesRead);
                                    const metadata = await parseFrontmatter(content);

                                    if (!metadata) continue;

                                    // 태그 필터
                                    if (tag) {
                                        const tags = metadata.tags;
                                        if (!Array.isArray(tags)) continue;
                                        if (!tags.some(t => String(t).toLowerCase().includes(tag.toLowerCase()))) continue;
                                    }

                                    // 속성 필터
                                    if (property && value) {
                                        const propValue = metadata[property];
                                        if (propValue === undefined) continue;

                                        if (Array.isArray(propValue)) {
                                            if (!propValue.some(v => String(v).toLowerCase().includes(value.toLowerCase()))) continue;
                                        } else {
                                            if (!String(propValue).toLowerCase().includes(value.toLowerCase())) continue;
                                        }
                                    }

                                    results.push({ path: fullPath, metadata });
                                } catch {
                                    continue;
                                }
                            } else {
                                results.push({ path: fullPath });
                            }
                        }
                    }
                } catch {
                    // 접근 권한 없는 디렉토리는 무시
                }
            }

            await searchDir(normalizedPath, 0);

            if (results.length === 0) {
                let msg = `마크다운 파일을 찾지 못했습니다.`;
                if (tag) msg += ` (태그: ${tag})`;
                if (property && value) msg += ` (${property}: ${value})`;
                return {
                    content: [{ type: "text", text: msg }],
                };
            }

            let output = `🔍 검색 결과 (${results.length}개 파일):\n\n`;
            for (const r of results) {
                output += `📝 ${r.path}\n`;
                if (r.metadata) {
                    if (r.metadata.title) output += `   제목: ${r.metadata.title}\n`;
                    if (r.metadata.tags) output += `   태그: ${JSON.stringify(r.metadata.tags)}\n`;
                }
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
// 도구 4: search_text_in_markdown
// ============================================

server.tool(
    "search_text_in_markdown",
    "Search for a literal string in markdown text (body + frontmatter). Not a regex search. For filename search, use 'search_markdown_files'. Example: {\"directory\":\"notes\",\"query\":\"TODO\"}.",
    {
        directory: z.string().describe("Root directory to search (must be a directory)."),
        query: z.string().describe("Literal text to find (non-empty, no regex)."),
        caseSensitive: z.boolean().optional().default(false).describe("Case-sensitive matching."),
        contextBefore: z.number().optional().default(0).describe("Number of lines to include before each match (integer >= 0)."),
        contextAfter: z.number().optional().default(0).describe("Number of lines to include after each match (integer >= 0)."),
        maxResults: z.number().optional().describe("Maximum total matches to return (integer > 0; stop early if reached)."),
        respectGitignore: z.boolean().optional().default(true).describe("Apply .gitignore rules."),
    },
    async ({ directory, query, caseSensitive, contextBefore, contextAfter, maxResults, respectGitignore }) => {
        try {
            const normalizedPath = normalizePath(directory);
            const startTime = Date.now();

            if (!(await exists(normalizedPath))) {
                return pathNotFoundError(normalizedPath);
            }

            const stats = await fs.stat(normalizedPath);
            if (!stats.isDirectory()) {
                return notDirectoryError(normalizedPath);
            }

            if (!query || query.trim().length == 0) {
                return createErrorResponse("query must be a non-empty string.");
            }

            if (!Number.isInteger(contextBefore) || contextBefore < 0) {
                return createErrorResponse("contextBefore must be an integer >= 0.");
            }

            if (!Number.isInteger(contextAfter) || contextAfter < 0) {
                return createErrorResponse("contextAfter must be an integer >= 0.");
            }

            if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults < 1)) {
                return createErrorResponse("maxResults must be an integer >= 1.");
            }

            const flags = caseSensitive ? "g" : "gi";
            const regex = new RegExp(escapeRegex(query), flags);

            const ig = respectGitignore ? await loadGitignore(normalizedPath) : null;

            interface SearchMatch {
                file: string;
                line: number;
                content: string;
                contextBefore?: string[];
                contextAfter?: string[];
            }

            const results: SearchMatch[] = [];
            let filesSearched = 0;
            let filesMatched = 0;

            async function searchInFile(filePath: string): Promise<void> {
                return new Promise((resolve) => {
                    const matches: SearchMatch[] = [];
                    const allLines: string[] = [];
                    const pendingAfterContext: Map<number, { match: SearchMatch; linesNeeded: number }> = new Map();
                    let lineNumber = 0;
                    let matchIndex = 0;

                    const rl = readline.createInterface({
                        input: createReadStream(filePath, { encoding: "utf8" }),
                        crlfDelay: Infinity,
                    });

                    rl.on("line", (line) => {
                        lineNumber++;
                        allLines.push(line);

                        // 진행 중인 contextAfter 수집
                        for (const [idx, pending] of pendingAfterContext) {
                            pending.match.contextAfter = pending.match.contextAfter || [];
                            pending.match.contextAfter.push(line);
                            pending.linesNeeded--;
                            if (pending.linesNeeded === 0) {
                                pendingAfterContext.delete(idx);
                            }
                        }

                        // 라인 버퍼 크기 제한
                        const maxBuffer = contextBefore + 100;
                        if (allLines.length > maxBuffer) {
                            allLines.shift();
                        }

                        regex.lastIndex = 0;
                        if (regex.test(line)) {
                            const match: SearchMatch = {
                                file: filePath,
                                line: lineNumber,
                                content: line.trim(),
                            };

                            if (contextBefore > 0) {
                                const startIdx = Math.max(0, allLines.length - 1 - contextBefore);
                                match.contextBefore = allLines.slice(startIdx, allLines.length - 1);
                            }

                            matches.push(match);

                            if (contextAfter > 0) {
                                pendingAfterContext.set(matchIndex, { match, linesNeeded: contextAfter });
                            }
                            matchIndex++;
                        }
                    });

                    rl.on("close", () => {
                        if (matches.length > 0) {
                            filesMatched++;
                            results.push(...matches);
                        }
                        resolve();
                    });

                    rl.on("error", () => resolve());
                });
            }

            async function walkDir(dir: string): Promise<void> {
                if (maxResults && results.length >= maxResults) return;

                try {
                    const entries = await fs.readdir(dir, { withFileTypes: true });

                    for (const entry of entries) {
                        if (maxResults && results.length >= maxResults) break;

                        const fullPath = path.join(dir, entry.name);
                        const relativePath = path.relative(normalizedPath, fullPath);

                        if (ig && ig.ignores(relativePath)) continue;

                        if (entry.isDirectory()) {
                            await walkDir(fullPath);
                        } else if (entry.isFile() && isMarkdownFile(entry.name)) {
                            filesSearched++;
                            await searchInFile(fullPath);
                        }
                    }
                } catch {
                    // 접근 권한 없는 디렉토리는 무시
                }
            }

            await walkDir(normalizedPath);

            const elapsedMs = Date.now() - startTime;

            if (results.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `"${query}"를 포함하는 마크다운 파일을 찾지 못했습니다.\n\n` +
                            `📊 통계: 검색한 파일 ${filesSearched}개, 소요 시간 ${elapsedMs}ms`
                    }],
                };
            }

            let output = "";
            for (const match of results) {
                if (match.contextBefore && match.contextBefore.length > 0) {
                    const startLine = match.line - match.contextBefore.length;
                    match.contextBefore.forEach((line, i) => {
                        output += `${match.file}:${startLine + i}: ${line}\n`;
                    });
                }
                output += `${match.file}:${match.line}: ${match.content}\n`;
                if (match.contextAfter && match.contextAfter.length > 0) {
                    match.contextAfter.forEach((line, i) => {
                        output += `${match.file}:${match.line + 1 + i}: ${line}\n`;
                    });
                }
                output += "\n";
            }

            return {
                content: [{
                    type: "text",
                    text: `검색 결과 (${results.length}개 매칭, ${filesMatched}개 파일):\n\n` +
                        output +
                        `📊 통계: 검색한 파일 ${filesSearched}개, 소요 시간 ${elapsedMs}ms`,
                }],
            };
        } catch (error) {
            return createErrorResponse(error instanceof Error ? error.message : String(error));
        }
    }
);

// ============================================
// 도구 5: read_markdown_toc
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
            const normalizedPath = normalizePath(filePath);

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
                    text: `📑 목차 (${toc.length}개 헤더):\n\n${output}`,
                }],
            };
        } catch (error) {
            return createErrorResponse(error instanceof Error ? error.message : String(error));
        }
    }
);

// ============================================
// 도구 6: read_markdown_section
// ============================================

server.tool(
    "read_markdown_section",
    "Read only the section under a specific header. Header text must match exactly (case-insensitive). Optionally include subsections. Example: {\"path\":\"README.md\",\"header\":\"Installation\"}.",
    {
        path: z.string().describe("Markdown file path."),
        header: z.string().describe("Header text to find (non-empty). Leading '#' is ignored."),
        includeSubsections: z.boolean().optional().default(true).describe("If true, include subsections; if false, only the exact section."),
    },
    async ({ path: filePath, header, includeSubsections }) => {
        try {
            const normalizedPath = normalizePath(filePath);

            if (!(await exists(normalizedPath))) {
                return pathNotFoundError(normalizedPath);
            }

            if (!isMarkdownFile(normalizedPath)) {
                return notMarkdownError(normalizedPath);
            }

            const content = await fs.readFile(normalizedPath, "utf8");
            const lines = content.split(/\r?\n/);

            const headerText = header.replace(/^#+\s*/, "").trim();
            if (!headerText) {
                return createErrorResponse("header must be a non-empty string.");
            }
            // 앞 공백 허용 (Obsidian 호환)
            const headerRegex = /^\s*(#{1,6})\s+(.+)$/;

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
                return {
                    content: [{
                        type: "text",
                        text: `헤더 "${headerText}"를 찾을 수 없습니다.`,
                    }],
                    isError: true,
                };
            }

            const sectionLines = lines.slice(startLine, endLine);
            const sectionContent = sectionLines.join("\n").trim();

            return {
                content: [{
                    type: "text",
                    text: `--- 섹션: ${lines[startLine]} (L${startLine + 1}-${endLine}) ---\n\n${sectionContent}`,
                }],
            };
        } catch (error) {
            return createErrorResponse(error instanceof Error ? error.message : String(error));
        }
    }
);

// ============================================
// 도구 7: read_markdown_full
// ============================================

server.tool(
    "read_markdown_full",
    "Read entire markdown file(s) and return frontmatter + body. If you only need a part, prefer 'read_markdown_section'. Example: {\"path\":\"README.md\"} or {\"paths\":[\"a.md\",\"b.md\"]}.",
    {
        path: z.string().optional().describe("Single file path. Use either 'path' or 'paths', not both."),
        paths: z.array(z.string()).optional().describe("Array of file paths. Use either 'path' or 'paths', not both."),
    },
    async ({ path: singlePath, paths: multiplePaths }) => {
        try {
            // path 또는 paths 중 하나는 필수
            if (singlePath && multiplePaths) {
                return createErrorResponse("Provide either 'path' or 'paths', not both.");
            }
            if (multiplePaths && multiplePaths.length === 0) {
                return createErrorResponse("'paths' must contain at least one path.");
            }
            const filePaths = multiplePaths || (singlePath ? [singlePath] : []);

            if (filePaths.length === 0) {
                return createErrorResponse("path 또는 paths 중 하나를 지정해야 합니다.");
            }

            const results: string[] = [];

            for (const filePath of filePaths) {
                const normalizedPath = normalizePath(filePath);

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

                    let output = `--- 📝 ${normalizedPath} ---\n\n`;

                    if (metadata && Object.keys(metadata).length > 0) {
                        output += `📋 메타데이터:\n${JSON.stringify(metadata, null, 2)}\n\n`;
                    }

                    output += `📄 본문:\n${body}\n`;
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
// 도구 8: get_linked_files
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
            const normalizedPath = normalizePath(filePath);

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

            let output = `🔗 링크 (${links.length}개 발견):\n\n`;

            const formatLink = (l: LinkInfo) => {
                const status = checkExists ? (l.exists ? "✅" : "❌") : "•";
                const displayTarget = l.type === "markdown" && !l.target.includes("/") ? `[[${l.target}]]` : l.target;
                return `  ${status} L${l.line}: ${displayTarget}${l.text ? ` (${l.text})` : ""}`;
            };

            if (grouped.markdown.length > 0) {
                output += `📝 마크다운 링크 (${grouped.markdown.length}개):\n`;
                grouped.markdown.forEach(l => output += formatLink(l) + "\n");
                output += "\n";
            }

            if (grouped.image.length > 0) {
                output += `🖼️ 이미지 (${grouped.image.length}개):\n`;
                grouped.image.forEach(l => output += formatLink(l) + "\n");
                output += "\n";
            }

            if (grouped.external.length > 0) {
                output += `🌐 외부 링크 (${grouped.external.length}개):\n`;
                grouped.external.forEach(l => output += formatLink(l) + "\n");
                output += "\n";
            }

            if (grouped.embed.length > 0) {
                output += `📎 임베드 (${grouped.embed.length}개):\n`;
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
// 서버 정보 리소스
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
                        version: "4.0.0",
                        description: "마크다운 전용 파일 탐색 MCP 서버",
                        features: [
                            "마크다운 파일 검색 및 필터링",
                            "프론트매터 태그 기반 검색",
                            "목차(TOC) 추출",
                            "섹션별 부분 읽기",
                            "링크 추출 및 존재 확인",
                            "복수 파일 일괄 읽기",
                        ],
                        tools: [
                            "list_directory",
                            "get_directory_tree",
                            "search_markdown_files",
                            "search_text_in_markdown",
                            "read_markdown_toc",
                            "read_markdown_section",
                            "read_markdown_full",
                            "get_linked_files",
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
    console.error("Markdown Explorer MCP 서버 v4.0.0이 시작되었습니다.");
}

main().catch((error) => {
    console.error("서버 시작 실패:", error);
    process.exit(1);
});
