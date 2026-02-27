import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { MAX_DEPTH } from "../config.js";
import { logger } from "../logger.js";
import {
    normalizeAndValidatePath, accessDeniedError, createErrorResponse,
    pathNotFoundError, notDirectoryError, exists, isMarkdownFile, loadGitignore,
} from "../utils.js";

export function registerDirectoryTree(server: McpServer) {
    server.tool(
        "get_directory_tree",
        `Navigation tool for recursive tree overview (folder structure only).

Use when:
- You need a high-level map of folders/files before searching.

Input rules:
- "path" should be a directory.
- Keep "depth" small to avoid overly large outputs.
- Paths are relative to BASE_DIR. Do not repeat the BASE_DIR name in the path (e.g. if BASE_DIR ends with "Projects", use "subfolder/file.md" not "Projects/subfolder/file.md").
- Send exactly one JSON object per tool call. Do not concatenate multiple JSON objects.`,
        {
            path: z.string().optional().default(".").describe("Root directory path for the tree. Defaults to base directory if omitted."),
            depth: z.number().optional().default(3).describe("Maximum depth to display (integer >= 1). Larger values increase output size/tokens (default 3)."),
            markdownOnly: z.boolean().optional().default(true).describe("Show only markdown files (.md/.mdx/.markdown) and directories. Default: true."),
            showHidden: z.boolean().optional().default(false).describe("Include hidden entries (names starting with .)."),
            respectGitignore: z.boolean().optional().default(true).describe("Apply .gitignore rules to exclude paths."),
        },
        async ({ path: dirPath, depth, markdownOnly, showHidden, respectGitignore }) => {
            try {
                const validatedPath = normalizeAndValidatePath(dirPath);
                if (validatedPath === null) {
                    return accessDeniedError(dirPath);
                }
                const normalizedPath = validatedPath;

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
                if (depth > MAX_DEPTH) {
                    return createErrorResponse(`depth must be <= ${MAX_DEPTH}. Received: ${depth}`);
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
                            const icon = entry.isDirectory() ? "[D] " : (isMarkdownFile(entry.name) ? "" : "[?] ");

                            lines.push(`${prefix}${connector}${icon}${entry.name}`);

                            if (entry.isDirectory()) {
                                const newPrefix = prefix + (isLast ? "    " : "│   ");
                                await buildTree(path.join(dir, entry.name), newPrefix, currentDepth + 1);
                            }
                        }
                    } catch (e) {
                        logger.debug(`Failed to access directory: ${dir}`, e);
                    }
                }

                lines.push(`${path.basename(normalizedPath)}/`);
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
}
