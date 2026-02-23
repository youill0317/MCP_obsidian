import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { MARKDOWN_EXTENSIONS, MAX_RESULTS } from "../config.js";
import { logger } from "../logger.js";
import {
    normalizeAndValidatePath,
    accessDeniedError,
    createErrorResponse,
    pathNotFoundError,
    exists,
    isMarkdownFile,
    loadGitignore,
} from "../utils.js";

type BacklinkReferenceType = "wiki-link" | "markdown-link" | "embed";

interface ParsedLink {
    target: string;
    type: BacklinkReferenceType;
}

function normalizeForComparison(filePath: string): string {
    const normalized = path.normalize(filePath).replace(/\\/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isExternalLinkTarget(target: string): boolean {
    // Keep Windows drive paths (e.g. C:\notes\file.md) as local paths.
    if (/^[A-Za-z]:[\\/]/.test(target)) {
        return false;
    }
    return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("//");
}

function stripQueryAndAnchor(target: string): string {
    let stripped = target.trim();
    const hashIndex = stripped.indexOf("#");
    if (hashIndex >= 0) {
        stripped = stripped.slice(0, hashIndex);
    }
    const queryIndex = stripped.indexOf("?");
    if (queryIndex >= 0) {
        stripped = stripped.slice(0, queryIndex);
    }
    return stripped.trim();
}

function parseMarkdownDestination(rawDestination: string): string {
    const destination = rawDestination.trim();
    if (!destination) {
        return "";
    }

    if (destination.startsWith("<")) {
        const end = destination.indexOf(">");
        if (end > 1) {
            return destination.slice(1, end).trim();
        }
    }

    const firstToken = destination.match(/^(\S+)/);
    return firstToken ? firstToken[1] : "";
}

function resolveLinkCandidates(sourceFilePath: string, rawTarget: string): string[] {
    let target = rawTarget.trim();
    if (!target) {
        return [];
    }

    if ((target.startsWith("\"") && target.endsWith("\"")) || (target.startsWith("'") && target.endsWith("'"))) {
        target = target.slice(1, -1).trim();
    }

    try {
        target = decodeURIComponent(target);
    } catch {
        // Keep original target when decode fails.
    }

    target = stripQueryAndAnchor(target);
    if (!target || isExternalLinkTarget(target)) {
        return [];
    }

    const resolvedBase = path.isAbsolute(target)
        ? path.resolve(target)
        : path.resolve(path.dirname(sourceFilePath), target);

    const candidates = new Set<string>();
    candidates.add(normalizeForComparison(resolvedBase));
    if (!path.extname(target)) {
        for (const extension of MARKDOWN_EXTENSIONS) {
            candidates.add(normalizeForComparison(`${resolvedBase}${extension}`));
        }
    }

    return Array.from(candidates);
}

function extractLinksFromLine(line: string): ParsedLink[] {
    const links: ParsedLink[] = [];

    const wikiRegex = /(!?)\[\[([^\]]+)\]\]/g;
    let wikiMatch: RegExpExecArray | null;
    while ((wikiMatch = wikiRegex.exec(line)) !== null) {
        const rawInner = wikiMatch[2].trim();
        if (!rawInner) {
            continue;
        }

        const linkPart = rawInner.split("|", 1)[0].trim();
        if (!linkPart) {
            continue;
        }

        links.push({
            target: linkPart,
            type: wikiMatch[1] === "!" ? "embed" : "wiki-link",
        });
    }

    const markdownRegex = /(!?)\[[^\]]*\]\(([^)]+)\)/g;
    let markdownMatch: RegExpExecArray | null;
    while ((markdownMatch = markdownRegex.exec(line)) !== null) {
        const destination = parseMarkdownDestination(markdownMatch[2]);
        if (!destination) {
            continue;
        }

        links.push({
            target: destination,
            type: markdownMatch[1] === "!" ? "embed" : "markdown-link",
        });
    }

    return links;
}

export function registerBacklinks(server: McpServer) {
    server.tool(
        "get_backlinks",
        `Reverse-link analysis tool. Finds markdown files that reference a target file.

Use when:
- You already know the target note path.
- You need backlink context (who references this note).

Do not use when:
- You need outgoing links from a file (use get_linked_files).
- You need semantic discovery by text query (use search_markdown).

Input rules:
- "path" is the target file path to be referenced.
- "directory" limits backlink scan scope.
- "maxResults" is clamped; increase carefully for large vaults.

Good examples:
- {"path":"notes/project.md"}
- {"path":"notes/architecture.md","directory":"notes","maxResults":30}

Bad examples:
- {"query":"project"}  // discovery belongs to search_markdown
- {"path":"notes"}  // directory path, not a file`,
        {
            path: z.string().describe("Target file path to find backlinks for."),
            directory: z.string().optional().default(".").describe("Root directory to search for backlinks. Defaults to base directory."),
            maxResults: z.number().optional().default(20).describe(`Maximum backlinks to return (max ${MAX_RESULTS}).`),
            respectGitignore: z.boolean().optional().default(true).describe("Apply .gitignore rules."),
        },
        async ({ path: targetPath, directory, maxResults, respectGitignore }) => {
            try {
                const validatedTargetPath = normalizeAndValidatePath(targetPath);
                if (validatedTargetPath === null) {
                    return accessDeniedError(targetPath);
                }
                const targetFilePath = validatedTargetPath;

                if (!(await exists(targetFilePath))) {
                    return pathNotFoundError(targetFilePath);
                }

                const validatedDir = normalizeAndValidatePath(directory);
                if (validatedDir === null) {
                    return accessDeniedError(directory);
                }
                const normalizedDir = validatedDir;

                if (!(await exists(normalizedDir))) {
                    return pathNotFoundError(normalizedDir);
                }

                const clampedMax = Math.min(Math.max(1, maxResults), MAX_RESULTS);
                const targetBaseName = path.basename(targetFilePath);
                const targetComparablePath = normalizeForComparison(path.resolve(targetFilePath));

                interface BacklinkResult {
                    sourceFile: string;
                    references: { line: number; text: string; type: BacklinkReferenceType }[];
                }

                const results: BacklinkResult[] = [];
                const ig = respectGitignore ? await loadGitignore(normalizedDir) : null;

                async function checkFileForBacklinks(filePath: string): Promise<void> {
                    if (path.resolve(filePath) === path.resolve(targetFilePath)) return;

                    try {
                        const content = await fs.readFile(filePath, "utf8");
                        const lines = content.split(/\r?\n/);
                        const references: { line: number; text: string; type: BacklinkReferenceType }[] = [];

                        let inCodeBlock = false;
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            if (line.startsWith("```")) {
                                inCodeBlock = !inCodeBlock;
                                continue;
                            }
                            if (inCodeBlock) continue;

                            const links = extractLinksFromLine(line);
                            if (links.length === 0) {
                                continue;
                            }

                            let matchedType: BacklinkReferenceType | null = null;
                            for (const link of links) {
                                const candidates = resolveLinkCandidates(filePath, link.target);
                                if (candidates.includes(targetComparablePath)) {
                                    matchedType = link.type;
                                    break;
                                }
                            }
                            if (!matchedType) {
                                continue;
                            }

                            references.push({
                                line: i + 1,
                                text: line.trim().substring(0, 120),
                                type: matchedType,
                            });

                            if (references.length >= 5) break;
                        }

                        if (references.length > 0) {
                            results.push({ sourceFile: filePath, references });
                        }
                    } catch (error) {
                        logger.debug(`backlinks: failed to read file: ${filePath}`, error);
                    }
                }

                async function walkForBacklinks(dir: string): Promise<void> {
                    if (results.length >= clampedMax) return;

                    try {
                        const entries = await fs.readdir(dir, { withFileTypes: true });
                        const fileEntries: string[] = [];
                        const dirEntries: string[] = [];

                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            const relativePath = path.relative(normalizedDir, fullPath);

                            if (ig && ig.ignores(relativePath)) continue;

                            if (entry.isDirectory()) {
                                dirEntries.push(fullPath);
                            } else if (entry.isFile() && isMarkdownFile(entry.name)) {
                                fileEntries.push(fullPath);
                            }
                        }

                        const BATCH_SIZE = 10;
                        for (let i = 0; i < fileEntries.length; i += BATCH_SIZE) {
                            const batch = fileEntries.slice(i, i + BATCH_SIZE);
                            await Promise.allSettled(batch.map((filePath) => checkFileForBacklinks(filePath)));
                        }

                        for (const dirPath of dirEntries) {
                            await walkForBacklinks(dirPath);
                        }
                    } catch (error) {
                        logger.debug(`backlinks: failed to read directory: ${dir}`, error);
                    }
                }

                await walkForBacklinks(normalizedDir);

                if (results.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: `No backlinks found for "${targetBaseName}".\n\nNo markdown files in the search scope reference this file.`,
                        }],
                    };
                }

                const topResults = results.slice(0, clampedMax);
                let output = `Backlinks for "${targetBaseName}" (${topResults.length} files):\n\n`;

                for (const result of topResults) {
                    output += `- ${result.sourceFile}\n`;
                    for (const reference of result.references) {
                        output += `  L${reference.line} [${reference.type}]: ${reference.text}\n`;
                    }
                    output += "\n";
                }

                return {
                    content: [{ type: "text", text: output.trim() }],
                };
            } catch (error) {
                return createErrorResponse(error instanceof Error ? error.message : String(error));
            }
        }
    );
}
