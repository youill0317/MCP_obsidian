import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { MAX_RESULTS } from "../config.js";
import { logger } from "../logger.js";
import {
    normalizeAndValidatePath, accessDeniedError, createErrorResponse,
    pathNotFoundError, exists, isMarkdownFile, loadGitignore,
    sanitizeQuery, parseFrontmatter, fuzzyMatch,
} from "../utils.js";

export function registerSearchMarkdown(server: McpServer) {
    server.tool(
        "search_markdown",
        "Unified search for markdown files. Searches filename, tags, AND content in ONE call. IMPORTANT: Provide exactly ONE query string per call. For multiple searches, call this tool multiple times. Example: {\"query\":\"project\"} or {\"query\":\"회의\", \"tag\":\"work\"}.",
        {
            query: z.string().describe("Search query - searches filename, frontmatter tags, and file content simultaneously."),
            tag: z.string().optional().describe("Filter by tag in frontmatter (substring match, case-insensitive)."),
            filenamePattern: z.string().optional().describe("Filename glob pattern filter (*, ? supported). Example: \"*회의*\"."),
            directory: z.string().optional().default(".").describe("Root directory to search. Defaults to base directory."),
            maxResults: z.number().optional().default(10).describe(`Maximum total results to return (integer > 0, max ${MAX_RESULTS}).`),
            respectGitignore: z.boolean().optional().default(true).describe("Apply .gitignore rules."),
            useRegex: z.boolean().optional().default(false).describe("If true, treat query as a regular expression pattern."),
            fuzzy: z.boolean().optional().default(false).describe("If true, use fuzzy matching (tolerant of typos). Cannot be used with useRegex."),
            frontmatterFilter: z.record(z.string()).optional().describe("Filter by frontmatter properties. Example: {\"status\":\"done\", \"category\":\"work\"}. Values are substring-matched, case-insensitive."),
            modifiedAfter: z.string().optional().describe("Only include files modified after this date (ISO format, e.g. \"2026-01-01\")."),
            modifiedBefore: z.string().optional().describe("Only include files modified before this date (ISO format, e.g. \"2026-12-31\")."),
        },
        async ({ query, tag, filenamePattern, directory, maxResults, respectGitignore, useRegex, fuzzy, frontmatterFilter, modifiedAfter, modifiedBefore }) => {
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

                if (useRegex && fuzzy) {
                    return createErrorResponse("fuzzy and useRegex cannot be enabled together.");
                }

                const clampedMaxResults = Math.min(Math.max(1, maxResults), MAX_RESULTS);
                const sanitizedQuery = sanitizeQuery(query);
                const queryLower = sanitizedQuery.toLowerCase();
                const tagLower = tag?.toLowerCase();
                const ig = respectGitignore ? await loadGitignore(normalizedPath) : null;

                // 정규식 검색 준비
                let queryRegex: RegExp | null = null;
                if (useRegex) {
                    try {
                        queryRegex = new RegExp(sanitizedQuery, "i");
                    } catch (e) {
                        return createErrorResponse(`잘못된 정규식 패턴입니다: ${sanitizedQuery}`);
                    }
                }

                // 날짜 필터 파싱
                const afterDate = modifiedAfter ? new Date(modifiedAfter) : null;
                const beforeDate = modifiedBefore ? new Date(modifiedBefore) : null;
                if (afterDate && isNaN(afterDate.getTime())) {
                    return createErrorResponse(`잘못된 날짜 형식입니다 (modifiedAfter): ${modifiedAfter}`);
                }
                if (beforeDate && isNaN(beforeDate.getTime())) {
                    return createErrorResponse(`잘못된 날짜 형식입니다 (modifiedBefore): ${modifiedBefore}`);
                }

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
                    if (filenameRegex && !filenameRegex.test(fileName)) {
                        return;
                    }

                    // 날짜 필터
                    if (afterDate || beforeDate) {
                        try {
                            const fileStat = await fs.stat(filePath);
                            if (afterDate && fileStat.mtime < afterDate) return;
                            if (beforeDate && fileStat.mtime > beforeDate) return;
                        } catch (e) {
                            logger.debug(`파일 stat 실패: ${filePath}`, e);
                            return;
                        }
                    }

                    const result: SearchResult = {
                        path: filePath,
                        matchTypes: [],
                        score: 0,
                    };

                    // 매칭 헬퍼: 정규식 / 퍼지 / 단순 문자열 비교
                    const matchesQuery = (text: string): boolean => {
                        if (queryRegex) return queryRegex.test(text);
                        if (fuzzy) return fuzzyMatch(text, sanitizedQuery);
                        return text.toLowerCase().includes(queryLower);
                    };

                    // 1. 파일명 매칭
                    if (matchesQuery(fileName)) {
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

                        // 프론트매터 파싱
                        const metadata = await parseFrontmatter(content);

                        // 프론트매터 속성 필터
                        if (frontmatterFilter && Object.keys(frontmatterFilter).length > 0) {
                            if (!metadata) return;
                            for (const [key, value] of Object.entries(frontmatterFilter)) {
                                const metaValue = metadata[key];
                                if (metaValue === undefined || metaValue === null) return;
                                const metaStr = String(metaValue).toLowerCase();
                                if (!metaStr.includes(value.toLowerCase())) return;
                            }
                        }

                        // 태그 검색 및 필터
                        if (metadata?.tags && Array.isArray(metadata.tags)) {
                            if (tagLower) {
                                const hasTag = metadata.tags.some(t =>
                                    String(t).toLowerCase().includes(tagLower)
                                );
                                if (!hasTag) return;
                            }

                            const matchedTags = metadata.tags.filter(t =>
                                matchesQuery(String(t))
                            );
                            if (matchedTags.length > 0) {
                                result.matchTypes.push("tag");
                                result.tags = matchedTags.map(String);
                                result.score += 8;
                            } else if (tagLower) {
                                result.tags = metadata.tags.filter(t =>
                                    String(t).toLowerCase().includes(tagLower)
                                ).map(String);
                            }
                        } else if (tagLower) {
                            return;
                        }

                        // 내용 검색 (첫 3개 매칭만)
                        const lines = content.split(/\r?\n/);
                        const contentMatches: { line: number; text: string }[] = [];
                        for (let i = 0; i < lines.length && contentMatches.length < 3; i++) {
                            if (matchesQuery(lines[i])) {
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
                    } catch (e) {
                        logger.debug(`파일 읽기 실패: ${filePath}`, e);
                    }

                    if (result.matchTypes.length > 0) {
                        results.push(result);
                    }
                }

                async function walkDir(dir: string): Promise<void> {
                    if (results.length >= clampedMaxResults * 2) return;

                    try {
                        const entries = await fs.readdir(dir, { withFileTypes: true });

                        const fileEntries: { fullPath: string; name: string }[] = [];
                        const dirEntries: string[] = [];

                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            const relativePath = path.relative(normalizedPath, fullPath);

                            if (ig && ig.ignores(relativePath)) continue;

                            if (entry.isDirectory()) {
                                dirEntries.push(fullPath);
                            } else if (entry.isFile() && isMarkdownFile(entry.name)) {
                                fileEntries.push({ fullPath, name: entry.name });
                            }
                        }

                        // 파일 검색 병렬 처리 (10개씩 배치)
                        const BATCH_SIZE = 10;
                        for (let i = 0; i < fileEntries.length; i += BATCH_SIZE) {
                            const batch = fileEntries.slice(i, i + BATCH_SIZE);
                            await Promise.allSettled(
                                batch.map(f => searchFile(f.fullPath, f.name))
                            );
                        }

                        for (const dirPath of dirEntries) {
                            await walkDir(dirPath);
                        }
                    } catch (e) {
                        logger.debug(`디렉토리 접근 실패: ${dir}`, e);
                    }
                }

                await walkDir(normalizedPath);

                if (results.length === 0) {
                    let suggestions = `"${query}" 검색 결과 없음\n\n`;
                    suggestions += `제안:\n`;
                    suggestions += `  • 다른 검색어 시도\n`;
                    suggestions += `  • 전체 구조 확인: get_directory_tree로 볼트 구조 파악\n`;

                    return {
                        content: [{ type: "text", text: suggestions }],
                    };
                }

                results.sort((a, b) => b.score - a.score);
                const topResults = results.slice(0, clampedMaxResults);

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
}
