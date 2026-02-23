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
        `Read tool for markdown structure. Extracts headers (H1-H6) as a table of contents.

Use when:
- You need a quick structural overview before reading sections.

Do not use when:
- You need full content body (use read_markdown_full).
- You need search/discovery across files (use search_markdown).

Input rules:
- "path" must point to one markdown file.
- "maxLevel" must be an integer 1..6.
- Headers inside fenced code blocks are ignored.

Good examples:
- {"path":"README.md"}
- {"path":"docs/guide.md","maxLevel":3}

Bad examples:
- {"path":"docs"}  // directory path, not a file
- {"path":"README.md","maxLevel":10}  // invalid level`,
        {
            path: z.string().describe("Markdown file path (must be a file)."),
            maxLevel: z.number().optional().default(6).describe("Maximum header level to include (integer 1-6)."),
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
                        content: [{ type: "text", text: "No headers found." }],
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
                        text: `Table of contents (${toc.length} headers):\n\n${output}`,
                    }],
                };
            } catch (error) {
                return createErrorResponse(error instanceof Error ? error.message : String(error));
            }
        }
    );
}
