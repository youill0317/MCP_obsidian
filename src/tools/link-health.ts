import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { MAX_RESULTS } from "../config.js";
import {
    normalizeAndValidatePath,
    accessDeniedError,
    createErrorResponse,
    pathNotFoundError,
    exists,
    isMarkdownFile,
    loadGitignore,
} from "../utils.js";

type LinkReferenceType = "wiki-link" | "markdown-link" | "embed";

interface ParsedLink {
    target: string;
    type: LinkReferenceType;
}

interface BrokenLink {
    source: string;
    line: number;
    target: string;
    type: LinkReferenceType;
}

interface FileStats {
    path: string;
    incoming: number;
    outgoingMarkdown: number;
    brokenMarkdown: number;
}

function normalizeComparable(filePath: string): string {
    const normalized = path.normalize(filePath).replace(/\\/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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

function isExternalLinkTarget(target: string): boolean {
    if (/^[A-Za-z]:[\\/]/.test(target)) {
        return false;
    }
    return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("//");
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

function resolveMarkdownCandidates(sourceFilePath: string, rawTarget: string): string[] {
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

    const hasExtension = Boolean(path.extname(target));
    const resolvedBase = path.isAbsolute(target)
        ? path.resolve(target)
        : path.resolve(path.dirname(sourceFilePath), target);

    const candidates = new Set<string>();
    candidates.add(normalizeComparable(resolvedBase));
    if (!hasExtension) {
        candidates.add(normalizeComparable(`${resolvedBase}.md`));
    }

    return Array.from(candidates);
}

function scoreFile(stat: FileStats): number {
    const brokenPenalty = stat.brokenMarkdown * 25;
    const orphanPenalty = stat.incoming === 0 ? 30 : 0;
    const isolatedPenalty = stat.incoming === 0 && stat.outgoingMarkdown === 0 ? 15 : 0;
    return Math.max(0, 100 - brokenPenalty - orphanPenalty - isolatedPenalty);
}

function rankSuggestionCandidates(orphanPath: string, allFiles: string[]): string[] {
    const orphanDir = path.dirname(orphanPath);
    const orphanTokens = new Set(
        path.basename(orphanPath, path.extname(orphanPath))
            .toLowerCase()
            .split(/[^a-z0-9가-힣]+/)
            .filter(Boolean)
    );

    const scored = allFiles
        .filter((candidate) => candidate !== orphanPath)
        .map((candidate) => {
            let score = 0;
            if (path.dirname(candidate) === orphanDir) {
                score += 2;
            }

            const base = path.basename(candidate, path.extname(candidate)).toLowerCase();
            const isIndexLike = ["index", "readme", "moc", "home"].includes(base);
            if (isIndexLike) {
                score += 3;
            }

            const candidateTokens = base.split(/[^a-z0-9가-힣]+/).filter(Boolean);
            for (const token of candidateTokens) {
                if (orphanTokens.has(token)) {
                    score += 1;
                }
            }

            return { candidate, score };
        })
        .sort((a, b) => b.score - a.score);

    return scored.filter((item) => item.score > 0).slice(0, 2).map((item) => item.candidate);
}

export function registerLinkHealth(server: McpServer) {
    server.tool(
        "get_link_health",
        "Analyze markdown link quality: broken links, orphan notes, and cleanup suggestions.",
        {
            directory: z.string().optional().default(".").describe("Scan directory."),
            maxResults: z.number().optional().default(20).describe("Maximum items shown per section."),
            respectGitignore: z.boolean().optional().default(true).describe("Apply gitignore filtering."),
            includeSuggestions: z.boolean().optional().default(true).describe("Include automated cleanup suggestions."),
        },
        async ({ directory, maxResults, respectGitignore, includeSuggestions }) => {
            try {
                const validatedDir = normalizeAndValidatePath(directory);
                if (validatedDir === null) {
                    return accessDeniedError(directory);
                }

                if (!(await exists(validatedDir))) {
                    return pathNotFoundError(validatedDir);
                }

                const normalizedDir = validatedDir;
                const clampedMax = Math.min(Math.max(1, maxResults), MAX_RESULTS);
                const ig = respectGitignore ? await loadGitignore(normalizedDir) : null;

                const markdownFiles: string[] = [];
                async function walk(dir: string): Promise<void> {
                    const entries = await fs.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        const relativePath = path.relative(normalizedDir, fullPath);
                        if (ig && ig.ignores(relativePath)) {
                            continue;
                        }

                        if (entry.isDirectory()) {
                            await walk(fullPath);
                        } else if (entry.isFile() && isMarkdownFile(entry.name)) {
                            markdownFiles.push(fullPath);
                        }
                    }
                }

                await walk(normalizedDir);

                if (markdownFiles.length === 0) {
                    return {
                        content: [{ type: "text", text: "No markdown files found in the scan scope." }],
                    };
                }

                const comparableToRealPath = new Map<string, string>();
                for (const file of markdownFiles) {
                    comparableToRealPath.set(normalizeComparable(path.resolve(file)), file);
                }

                const incomingCounts = new Map<string, number>();
                const outgoingCounts = new Map<string, number>();
                const brokenCounts = new Map<string, number>();
                const brokenLinks: BrokenLink[] = [];

                for (const sourceFile of markdownFiles) {
                    const content = await fs.readFile(sourceFile, "utf8");
                    const lines = content.split(/\r?\n/);
                    let inCodeBlock = false;
                    let outgoingMarkdown = 0;
                    let brokenMarkdown = 0;

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        if (line.startsWith("```")) {
                            inCodeBlock = !inCodeBlock;
                            continue;
                        }
                        if (inCodeBlock) {
                            continue;
                        }

                        const links = extractLinksFromLine(line);
                        for (const link of links) {
                            if (link.type === "embed") {
                                continue;
                            }

                            const candidates = resolveMarkdownCandidates(sourceFile, link.target);
                            if (candidates.length === 0) {
                                continue;
                            }

                            outgoingMarkdown += 1;
                            const resolvedMatch = candidates.find((candidate) => comparableToRealPath.has(candidate));
                            if (resolvedMatch) {
                                const targetRealPath = comparableToRealPath.get(resolvedMatch)!;
                                incomingCounts.set(targetRealPath, (incomingCounts.get(targetRealPath) ?? 0) + 1);
                            } else {
                                brokenMarkdown += 1;
                                brokenLinks.push({
                                    source: sourceFile,
                                    line: i + 1,
                                    target: link.target,
                                    type: link.type,
                                });
                            }
                        }
                    }

                    outgoingCounts.set(sourceFile, outgoingMarkdown);
                    brokenCounts.set(sourceFile, brokenMarkdown);
                }

                const stats: FileStats[] = markdownFiles.map((file) => ({
                    path: file,
                    incoming: incomingCounts.get(file) ?? 0,
                    outgoingMarkdown: outgoingCounts.get(file) ?? 0,
                    brokenMarkdown: brokenCounts.get(file) ?? 0,
                }));

                const orphans = stats.filter((stat) => stat.incoming === 0);
                const fileScores = stats.map((stat) => ({ ...stat, score: scoreFile(stat) }));
                const vaultScore = Math.round(fileScores.reduce((sum, item) => sum + item.score, 0) / fileScores.length);

                const worstFiles = fileScores
                    .filter((item) => item.score < 100)
                    .sort((a, b) => a.score - b.score)
                    .slice(0, clampedMax);

                const brokenTop = brokenLinks.slice(0, clampedMax);

                let output = "Link health report\n\n";
                output += `Scope: ${normalizedDir}\n`;
                output += `Vault score: ${vaultScore}/100\n`;
                output += `Markdown files: ${markdownFiles.length}\n`;
                output += `Broken markdown links: ${brokenLinks.length}\n`;
                output += `Orphan notes (no incoming links): ${orphans.length}\n\n`;

                if (brokenTop.length > 0) {
                    output += `[Broken links]\n`;
                    for (const item of brokenTop) {
                        output += `- ${item.source} L${item.line} [${item.type}]: ${item.target}\n`;
                    }
                    output += "\n";
                }

                if (orphans.length > 0) {
                    output += `[Orphan notes]\n`;
                    for (const orphan of orphans.slice(0, clampedMax)) {
                        output += `- ${orphan.path} (outgoing:${orphan.outgoingMarkdown}, broken:${orphan.brokenMarkdown})\n`;
                    }
                    output += "\n";
                }

                if (worstFiles.length > 0) {
                    output += `[Low score files]\n`;
                    for (const item of worstFiles) {
                        output += `- ${item.path}: ${item.score}/100 (incoming:${item.incoming}, outgoing:${item.outgoingMarkdown}, broken:${item.brokenMarkdown})\n`;
                    }
                    output += "\n";
                }

                if (includeSuggestions) {
                    output += `[Cleanup suggestions]\n`;
                    if (brokenLinks.length === 0 && orphans.length === 0) {
                        output += "- No cleanup actions needed. Link graph is healthy.\n";
                    } else {
                        if (brokenLinks.length > 0) {
                            output += "- Prioritize fixing broken links first (largest score impact):\n";
                            for (const broken of brokenTop.slice(0, 5)) {
                                output += `  - Update target in ${broken.source} L${broken.line}: ${broken.target}\n`;
                            }
                        }

                        const orphanTop = orphans.slice(0, Math.min(5, clampedMax));
                        if (orphanTop.length > 0) {
                            output += "- Connect orphan notes from index/MOC pages or neighboring topic notes:\n";
                            for (const orphan of orphanTop) {
                                const candidates = rankSuggestionCandidates(orphan.path, markdownFiles);
                                if (candidates.length > 0) {
                                    output += `  - ${orphan.path} -> add links from ${candidates.join(", ")}\n`;
                                } else {
                                    output += `  - ${orphan.path} -> add at least one inbound link from a related project summary note\n`;
                                }
                            }
                        }
                    }
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
