import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { MAX_FILE_SIZE, MAX_PATHS } from "../config.js";
import { logger } from "../logger.js";
import {
    normalizeAndValidatePath, accessDeniedError, createErrorResponse,
    pathNotFoundError, exists, isMarkdownFile, formatFileSize,
    sanitizeQuery, loadGitignore, parseFrontmatter, extractBody,
} from "../utils.js";

export function registerReadFull(server: McpServer) {
    server.tool(
        "read_markdown_full",
        "Read entire markdown file(s) and return frontmatter + body. Supports: (1) direct path, (2) multiple paths, (3) SEARCH mode. IMPORTANT: Provide exactly ONE query string per call. Example: {\"path\":\"README.md\"} or {\"query\":\"개발일지\"}.",
        {
            path: z.string().optional().describe("Single file path. Use 'path', 'paths', or 'query'."),
            paths: z.array(z.string()).max(MAX_PATHS).optional().describe(`Array of file paths (max ${MAX_PATHS}).`),
            query: z.string().optional().describe("Search query to find and read files. Use when you don't know the exact path."),
            directory: z.string().optional().default(".").describe("Root directory for query search."),
            maxFiles: z.number().optional().default(3).describe("Max files to read when using query (1-10)."),
        },
        async ({ path: singlePath, paths: multiplePaths, query, directory, maxFiles }) => {
            try {
                let filePaths: string[] = [];

                if (query) {
                    if (singlePath || multiplePaths) {
                        return createErrorResponse("When using 'query', do not provide 'path' or 'paths'.");
                    }

                    const validatedDir = normalizeAndValidatePath(directory);
                    if (validatedDir === null) {
                        return accessDeniedError(directory);
                    }
                    const normalizedDir = validatedDir;
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

                                    if (entry.name.toLowerCase().includes(queryLower)) {
                                        score += 10;
                                    }

                                    try {
                                        const fileHandle = await fs.open(fullPath, "r");
                                        const buffer = Buffer.alloc(4096);
                                        const { bytesRead } = await fileHandle.read(buffer, 0, 4096, 0);
                                        await fileHandle.close();
                                        const content = buffer.toString("utf8", 0, bytesRead).toLowerCase();

                                        if (content.includes(queryLower)) {
                                            score += 5;
                                        }
                                    } catch (e) {
                                        logger.debug(`파일 읽기 실패: ${fullPath}`, e);
                                    }

                                    if (score > 0) {
                                        scored.push({ path: fullPath, score });
                                    }
                                }
                            }
                        } catch (e) {
                            logger.debug(`디렉토리 순회 실패: ${dir}`, e);
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
                        const fileStat = await fs.stat(normalizedPath);
                        if (fileStat.size > MAX_FILE_SIZE) {
                            results.push(`--- ${normalizedPath} ---\n[오류: 파일이 너무 큽니다 (${formatFileSize(fileStat.size)}, 최대 ${formatFileSize(MAX_FILE_SIZE)})]\n`);
                            continue;
                        }
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
}
