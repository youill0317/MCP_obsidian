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
            occurrence: z.number().int().min(1).optional().default(1).describe("Occurrence order when duplicate headers exist (1-based)."),
            includeSubsections: z.boolean().optional().default(true).describe("Include nested subsections."),
        },
        async ({ path: filePath, header, occurrence, includeSubsections }) => {
            try {
                const headerText = header.replace(/^#+\s*/, "").trim();
                if (!headerText) {
                    return createErrorResponse("header must be a non-empty string.");
                }

                const headerRegex = /^\s*(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/;

                function normalizeHeadingText(input: string): string {
                    return input
                        .replace(/^#+\s*/, "")
                        .replace(/\s+#+\s*$/, "")
                        .trim()
                        .replace(/\s+/g, " ")
                        .toLowerCase();
                }

                async function extractSection(normalizedPath: string): Promise<{
                    found: boolean;
                    content: string;
                    totalMatches: number;
                }> {
                    const content = await fs.readFile(normalizedPath, "utf8");
                    const lines = content.split(/\r?\n/);

                    let targetLevel = 0;
                    let startLine = -1;
                    let endLine = lines.length;
                    let targetSeenCount = 0;
                    let inCodeBlock = false;
                    const normalizedTargetHeader = normalizeHeadingText(headerText);

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
                        const text = normalizeHeadingText(match[2]);

                        if (startLine === -1) {
                            if (text === normalizedTargetHeader) {
                                targetSeenCount += 1;
                                if (targetSeenCount === occurrence) {
                                    startLine = lineIndex;
                                    targetLevel = level;
                                }
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
                        return { found: false, content: "", totalMatches: targetSeenCount };
                    }

                    const sectionLines = lines.slice(startLine, endLine);
                    const sectionContent = sectionLines.join("\n").trim();
                    return {
                        found: true,
                        totalMatches: targetSeenCount,
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
                            text: `Header "${headerText}" occurrence ${occurrence} was not found in ${normalizedPath}. (matched headers: ${result.totalMatches})`,
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
