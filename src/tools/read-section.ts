import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import {
    normalizeAndValidatePath,
    accessDeniedError,
    createErrorResponse,
    pathNotFoundError,
    notMarkdownError,
    exists,
    isMarkdownFile,
} from "../utils.js";

export function registerReadSection(server: McpServer) {
    server.tool(
        "read_markdown_section",
        `Read tool for one header section from a known markdown file.

Use when:
- You know the file path and the target header.
- You want a focused section instead of full file content.

Do not use when:
- You do not know the file path (use search_markdown first).
- You need the full file body (use read_markdown_full).

Input rules:
- "path" is required.
- "header" must be non-empty (leading '#' is allowed and ignored).
- Set "includeSubsections" to false for strict single-section extraction.

Good examples:
- {"path":"README.md","header":"Install"}
- {"path":"docs/guide.md","header":"## API","includeSubsections":false}

Bad examples:
- {"header":"Install"}  // missing required path
- {"path":"README.md","header":""}  // empty header`,
        {
            path: z.string().describe("Required markdown file path (inside BASE_DIRS)."),
            header: z.string().describe("Required target header text. Leading '#' is ignored."),
            includeSubsections: z.boolean().optional().default(true).describe("If true, include nested subsections until same or higher header level."),
        },
        async ({ path: filePath, header, includeSubsections }) => {
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

                    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                        const line = lines[lineIndex];

                        if (line.startsWith("```")) {
                            inCodeBlock = !inCodeBlock;
                            continue;
                        }
                        if (inCodeBlock) continue;

                        const match = line.match(headerRegex);
                        if (!match) {
                            continue;
                        }

                        const level = match[1].length;
                        const text = match[2].trim();

                        if (startLine === -1) {
                            if (text.toLowerCase() === headerText.toLowerCase()) {
                                startLine = lineIndex;
                                targetLevel = level;
                            }
                            continue;
                        }

                        if (includeSubsections) {
                            if (level <= targetLevel) {
                                endLine = lineIndex;
                                break;
                            }
                        } else {
                            endLine = lineIndex;
                            break;
                        }
                    }

                    if (startLine === -1) {
                        return { found: false, content: "" };
                    }

                    const sectionLines = lines.slice(startLine, endLine);
                    const sectionContent = sectionLines.join("\n").trim();
                    return {
                        found: true,
                        content: `--- ${normalizedPath} | section: ${lines[startLine]} (L${startLine + 1}-${endLine}) ---\n\n${sectionContent}`,
                    };
                }

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
                            text: `Header "${headerText}" was not found in ${normalizedPath}.`,
                        }],
                        isError: true,
                    };
                }

                return {
                    content: [{ type: "text", text: result.content }],
                };
            } catch (error) {
                return createErrorResponse(error instanceof Error ? error.message : String(error));
            }
        }
    );
}
