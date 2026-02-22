import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import {
    normalizeAndValidatePath, accessDeniedError, createErrorResponse,
    pathNotFoundError, notMarkdownError, exists, isMarkdownFile,
} from "../utils.js";

export function registerReadToc(server: McpServer) {
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
}
