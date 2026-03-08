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
        "Read one named section from a known markdown file.",
        {
            path: z.string().describe("Markdown file path."),
            header: z.string().describe("Header text."),
            includeSubsections: z.boolean().optional().default(true).describe("Include nested subsections."),
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
