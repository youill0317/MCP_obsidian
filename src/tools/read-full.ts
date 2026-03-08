import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import { MAX_FILE_SIZE, MAX_PATHS } from "../config.js";
import { logger } from "../logger.js";
import {
    normalizeAndValidatePath,
    accessDeniedError,
    createErrorResponse,
    exists,
    isMarkdownFile,
    formatFileSize,
    parseFrontmatter,
    extractBody,
} from "../utils.js";

export function registerReadFull(server: McpServer) {
    server.tool(
        "read_markdown_full",
        "Read one or more markdown files.",
        {
            path: z.string().optional().describe("Markdown file path."),
            paths: z.array(z.string()).max(MAX_PATHS).optional().describe("Markdown file paths."),
        },
        async ({ path: singlePath, paths: multiplePaths }) => {
            try {
                if (singlePath && multiplePaths) {
                    return createErrorResponse("Provide either 'path' or 'paths', not both.");
                }
                if (multiplePaths && multiplePaths.length === 0) {
                    return createErrorResponse("'paths' must contain at least one path.");
                }
                const filePaths = multiplePaths || (singlePath ? [singlePath] : []);
                if (filePaths.length === 0) {
                    return createErrorResponse("Provide one of: path or paths.");
                }

                const outputs: string[] = [];
                for (const filePath of filePaths) {
                    const validatedPath = normalizeAndValidatePath(filePath);
                    if (validatedPath === null) {
                        outputs.push(`--- ${filePath} ---\n[Error: access denied (outside BASE_DIRS)]\n`);
                        continue;
                    }
                    const normalizedPath = validatedPath;

                    if (!(await exists(normalizedPath))) {
                        outputs.push(`--- ${normalizedPath} ---\n[Error: file not found]\n`);
                        continue;
                    }

                    if (!isMarkdownFile(normalizedPath)) {
                        outputs.push(`--- ${normalizedPath} ---\n[Error: not a markdown file]\n`);
                        continue;
                    }

                    try {
                        const fileStat = await fs.stat(normalizedPath);
                        if (fileStat.size > MAX_FILE_SIZE) {
                            outputs.push(`--- ${normalizedPath} ---\n[Error: file too large (${formatFileSize(fileStat.size)}, max ${formatFileSize(MAX_FILE_SIZE)})]\n`);
                            continue;
                        }

                        const content = await fs.readFile(normalizedPath, "utf8");
                        const metadata = await parseFrontmatter(content);
                        const body = extractBody(content);

                        let output = `--- ${normalizedPath} ---\n\n`;
                        if (metadata && Object.keys(metadata).length > 0) {
                            output += `[Metadata]\n${JSON.stringify(metadata, null, 2)}\n\n`;
                        }
                        output += `[Body]\n${body}\n`;
                        outputs.push(output);
                    } catch (error) {
                        logger.debug(`Failed to read markdown file: ${normalizedPath}`, error);
                        outputs.push(`--- ${normalizedPath} ---\n[Error: ${error instanceof Error ? error.message : String(error)}]\n`);
                    }
                }

                return {
                    content: [{
                        type: "text",
                        text: outputs.join("\n"),
                    }],
                };
            } catch (error) {
                return createErrorResponse(error instanceof Error ? error.message : String(error));
            }
        }
    );
}
