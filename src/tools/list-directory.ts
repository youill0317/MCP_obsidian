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
        "List one directory level.",
        {
            path: z.string().optional().default(".").describe("Directory path."),
            markdownOnly: z.boolean().optional().default(true).describe("Show only markdown entries."),
            showHidden: z.boolean().optional().default(false).describe("Include hidden entries, except dot-prefixed directories which are always denied."),
            respectGitignore: z.boolean().optional().default(true).describe("Apply gitignore filtering."),
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

                entries = entries.filter((e) => !(e.isDirectory() && e.name.startsWith(".")));

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
