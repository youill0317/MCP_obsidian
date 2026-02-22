import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "../logger.js";
import {
    normalizeAndValidatePath, accessDeniedError, createErrorResponse,
    pathNotFoundError, notMarkdownError, exists, isMarkdownFile, loadGitignore,
} from "../utils.js";

export function registerReadSection(server: McpServer) {
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
                const validatedDir = normalizeAndValidatePath(directory);
                if (validatedDir === null) {
                    return accessDeniedError(directory);
                }
                const normalizedDir = validatedDir;
                if (!(await exists(normalizedDir))) {
                    return pathNotFoundError(normalizedDir);
                }

                const ig = await loadGitignore(normalizedDir);
                const foundFiles: string[] = [];
                const limitedMax = Math.min(Math.max(1, maxFiles), 10);

                async function searchForHeader(dir: string): Promise<void> {
                    if (foundFiles.length >= limitedMax * 3) return;

                    try {
                        const entries = await fs.readdir(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            const relativePath = path.relative(normalizedDir, fullPath);

                            if (ig.ignores(relativePath)) continue;

                            if (entry.isDirectory()) {
                                await searchForHeader(fullPath);
                            } else if (entry.isFile() && isMarkdownFile(entry.name)) {
                                try {
                                    const content = await fs.readFile(fullPath, "utf8");
                                    if (content.toLowerCase().includes(headerText.toLowerCase())) {
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
                    } catch (e) {
                        logger.debug(`디렉토리 접근 실패: ${dir}`, e);
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
                    } catch (e) {
                        logger.debug(`섹션 추출 실패: ${file}`, e);
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
}
