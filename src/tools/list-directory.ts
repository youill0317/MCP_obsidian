import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "../logger.js";
import {
    normalizeAndValidatePath, accessDeniedError, createErrorResponse,
    pathNotFoundError, notDirectoryError, exists, isMarkdownFile,
    formatFileSize, loadGitignore,
} from "../utils.js";

export function registerListDirectory(server: McpServer) {
    server.tool(
        "list_directory",
        `Navigation tool for one-level directory listing.

Use when:
- You want controlled, step-by-step exploration.
- You need immediate child folders/files with sizes.

Do not use when:
- You need recursive tree output (use get_directory_tree).
- You need semantic search by query/tag/content (use search_markdown).

Input rules:
- "path" should be a directory.
- Call repeatedly on child directories to explore deeper.

Good examples:
- {"path":"notes"}
- {"path":"notes/projectA","markdownOnly":false}

Bad examples:
- {"path":"README.md"}  // file path, not a directory
- {"query":"project"}  // query search belongs to search_markdown`,
        {
            path: z.string().optional().default(".").describe("Directory path to list. Defaults to base directory."),
            markdownOnly: z.boolean().optional().default(true).describe("If true, show only markdown files and directories."),
            showHidden: z.boolean().optional().default(false).describe("Include hidden entries (names starting with .)."),
            respectGitignore: z.boolean().optional().default(true).describe("If true, apply .gitignore rules to exclude paths."),
        },
        async ({ path: dirPath, markdownOnly, showHidden, respectGitignore }) => {
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

                const ig = respectGitignore ? await loadGitignore(normalizedPath) : null;

                let entries = await fs.readdir(normalizedPath, { withFileTypes: true });

                if (!showHidden) {
                    entries = entries.filter((e) => !e.name.startsWith("."));
                }

                if (ig) {
                    entries = entries.filter((e) => {
                        const relativePath = path.relative(normalizedPath, path.join(normalizedPath, e.name));
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

                if (entries.length === 0) {
                    const typeNote = markdownOnly ? " (markdownOnly=true)" : "";
                    return {
                        content: [{
                            type: "text",
                            text: `Directory is empty${typeNote}: ${normalizedPath}`,
                        }],
                    };
                }

                const lines: string[] = [];
                let dirCount = 0;
                let fileCount = 0;

                for (const entry of entries) {
                    const fullPath = path.join(normalizedPath, entry.name);

                    if (entry.isDirectory()) {
                        let childCount = 0;
                        try {
                            const children = await fs.readdir(fullPath);
                            childCount = children.length;
                        } catch (e) {
                            logger.debug(`Failed to read directory: ${fullPath}`, e);
                        }
                        lines.push(`  [DIR] ${entry.name}/ (${childCount} items)`);
                        dirCount++;
                    } else {
                        try {
                            const fileStat = await fs.stat(fullPath);
                            lines.push(`  [FILE] ${entry.name} (${formatFileSize(fileStat.size)})`);
                        } catch {
                            lines.push(`  [FILE] ${entry.name}`);
                        }
                        fileCount++;
                    }
                }

                let header = `${normalizedPath}\n`;
                header += `${dirCount} directories, ${fileCount} files\n`;

                if (dirCount > 0) {
                    header += `\nTip: Call list_directory on any subdirectory to explore deeper.\n`;
                }

                return {
                    content: [{
                        type: "text",
                        text: header + "\n" + lines.join("\n"),
                    }],
                };
            } catch (error) {
                return createErrorResponse(error instanceof Error ? error.message : String(error));
            }
        }
    );
}
