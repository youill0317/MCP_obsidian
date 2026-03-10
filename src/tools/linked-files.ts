import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { BASE_DIRS } from "../config.js";
import { collectMarkdownFiles } from "../core/markdown-search.js";
import {
    normalizeAndValidatePath,
    accessDeniedError,
    createErrorResponse,
    pathNotFoundError,
    notMarkdownError,
    exists,
    isMarkdownFile,
} from "../utils.js";

export function registerLinkedFiles(server: McpServer) {
    server.tool(
        "get_linked_files",
        "List outgoing links from a markdown file.",
        {
            path: z.string().describe("Markdown file path."),
            type: z.enum(["all", "markdown", "image", "external", "embed"]).optional().default("all").describe("Link type filter."),
            checkExists: z.boolean().optional().default(false).describe("Check local target existence."),
        },
        async ({ path: filePath, type, checkExists }) => {
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

                const content = await fs.readFile(normalizedPath, "utf8");
                const fileDir = path.dirname(normalizedPath);

                interface LinkInfo {
                    type: "markdown" | "image" | "external" | "embed";
                    target: string;
                    text?: string;
                    line: number;
                    exists?: boolean;
                    resolvedPath?: string;
                    outsideBaseDir?: boolean;
                }

                const links: LinkInfo[] = [];
                const lines = content.split(/\r?\n/);
                let inCodeBlock = false;

                const markdownLinkRegex = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
                const wikiLinkRegex = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
                const embedRegex = /!\[\[([^\]]+)\]\]/g;
                const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;

                const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp"];
                type WikiNameIndex = Map<string, string[]>;

                async function buildWikiNameIndex(): Promise<WikiNameIndex> {
                    const index: WikiNameIndex = new Map();

                    for (const baseDir of BASE_DIRS) {
                        const markdownFiles = await collectMarkdownFiles({ rootDir: baseDir, respectGitignore: true });
                        for (const markdownFile of markdownFiles) {
                            const baseName = path.basename(markdownFile, path.extname(markdownFile)).toLowerCase();
                            const existing = index.get(baseName);
                            if (existing) {
                                existing.push(markdownFile);
                            } else {
                                index.set(baseName, [markdownFile]);
                            }
                        }
                    }

                    return index;
                }

                const wikiNameIndex = checkExists ? await buildWikiNameIndex() : null;

                async function checkLinkTargetExists(linkInfo: LinkInfo, unresolvedPath: string): Promise<void> {
                    const resolvedPath = path.resolve(fileDir, unresolvedPath);
                    const validated = normalizeAndValidatePath(resolvedPath);

                    if (validated === null) {
                        linkInfo.outsideBaseDir = true;
                        linkInfo.exists = false;
                        return;
                    }

                    linkInfo.resolvedPath = validated;
                    linkInfo.exists = await exists(validated);
                }

                async function checkWikiLinkTargetExists(linkInfo: LinkInfo, wikiTarget: string): Promise<void> {
                    const baseTarget = wikiTarget.split("#", 1)[0].trim();
                    if (!baseTarget) {
                        linkInfo.exists = false;
                        return;
                    }

                    const looksLikePath = baseTarget.includes("/") || baseTarget.includes("\\") || baseTarget.startsWith(".");
                    if (looksLikePath) {
                        const wikiPath = path.extname(baseTarget) ? baseTarget : `${baseTarget}.md`;
                        await checkLinkTargetExists(linkInfo, wikiPath);
                        return;
                    }

                    const lookupKey = path.basename(baseTarget, path.extname(baseTarget)).toLowerCase();
                    const candidates = wikiNameIndex?.get(lookupKey) || [];
                    if (candidates.length === 0) {
                        linkInfo.exists = false;
                        return;
                    }

                    for (const candidate of candidates) {
                        const validated = normalizeAndValidatePath(candidate);
                        if (!validated) {
                            continue;
                        }

                        const candidateExists = await exists(validated);
                        if (candidateExists) {
                            linkInfo.exists = true;
                            linkInfo.resolvedPath = validated;
                            return;
                        }
                    }

                    linkInfo.exists = false;
                }

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const lineNum = i + 1;

                    if (line.startsWith("```")) {
                        inCodeBlock = !inCodeBlock;
                        continue;
                    }
                    if (inCodeBlock) continue;

                    let match;

                    while ((match = markdownLinkRegex.exec(line)) !== null) {
                        const target = match[2];
                        const isExternal = /^https?:\/\//.test(target);
                        const ext = path.extname(target).toLowerCase();
                        const isImage = imageExtensions.includes(ext);

                        let linkType: LinkInfo["type"];
                        if (isExternal) linkType = "external";
                        else if (isImage) linkType = "image";
                        else linkType = "markdown";

                        if (type === "all" || type === linkType) {
                            const linkInfo: LinkInfo = {
                                type: linkType,
                                target,
                                text: match[1] || undefined,
                                line: lineNum,
                            };

                            if (checkExists && !isExternal) {
                                await checkLinkTargetExists(linkInfo, target);
                            }

                            links.push(linkInfo);
                        }
                    }

                    while ((match = wikiLinkRegex.exec(line)) !== null) {
                        if (type === "all" || type === "markdown") {
                            const target = match[1];
                            const linkInfo: LinkInfo = {
                                type: "markdown",
                                target,
                                text: match[2] || undefined,
                                line: lineNum,
                            };

                            if (checkExists) {
                                await checkWikiLinkTargetExists(linkInfo, target);
                            }

                            links.push(linkInfo);
                        }
                    }

                    while ((match = embedRegex.exec(line)) !== null) {
                        if (type === "all" || type === "embed") {
                            const target = match[1];
                            const linkInfo: LinkInfo = {
                                type: "embed",
                                target,
                                line: lineNum,
                            };

                            if (checkExists) {
                                await checkLinkTargetExists(linkInfo, target);
                            }

                            links.push(linkInfo);
                        }
                    }

                    while ((match = imageRegex.exec(line)) !== null) {
                        const target = match[2];
                        const isExternal = /^https?:\/\//.test(target);

                        if (type === "all" || type === "image" || (isExternal && type === "external")) {
                            const linkInfo: LinkInfo = {
                                type: isExternal ? "external" : "image",
                                target,
                                text: match[1] || undefined,
                                line: lineNum,
                            };

                            if (checkExists && !isExternal) {
                                await checkLinkTargetExists(linkInfo, target);
                            }

                            links.push(linkInfo);
                        }
                    }

                    markdownLinkRegex.lastIndex = 0;
                    wikiLinkRegex.lastIndex = 0;
                    embedRegex.lastIndex = 0;
                    imageRegex.lastIndex = 0;
                }

                if (links.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: type === "all"
                                ? "No links found."
                                : `No "${type}" links found.`,
                        }],
                    };
                }

                const grouped = {
                    markdown: links.filter((link) => link.type === "markdown"),
                    image: links.filter((link) => link.type === "image"),
                    external: links.filter((link) => link.type === "external"),
                    embed: links.filter((link) => link.type === "embed"),
                };

                let output = `Links (${links.length} found):\n\n`;

                const formatLink = (link: LinkInfo) => {
                    const status = checkExists
                        ? (link.outsideBaseDir ? "[OUTSIDE]" : (link.exists ? "[OK]" : "[MISSING]"))
                        : "-";
                    const displayTarget = link.type === "markdown" && !link.target.includes("/")
                        ? `[[${link.target}]]`
                        : link.target;
                    const reason = link.outsideBaseDir ? " (outside BASE_DIRS)" : "";
                    return `  ${status} L${link.line}: ${displayTarget}${link.text ? ` (${link.text})` : ""}${reason}`;
                };

                if (grouped.markdown.length > 0) {
                    output += `[Markdown] (${grouped.markdown.length}):\n`;
                    grouped.markdown.forEach((link) => { output += formatLink(link) + "\n"; });
                    output += "\n";
                }

                if (grouped.image.length > 0) {
                    output += `[Image] (${grouped.image.length}):\n`;
                    grouped.image.forEach((link) => { output += formatLink(link) + "\n"; });
                    output += "\n";
                }

                if (grouped.external.length > 0) {
                    output += `[External] (${grouped.external.length}):\n`;
                    grouped.external.forEach((link) => { output += formatLink(link) + "\n"; });
                    output += "\n";
                }

                if (grouped.embed.length > 0) {
                    output += `[Embed] (${grouped.embed.length}):\n`;
                    grouped.embed.forEach((link) => { output += formatLink(link) + "\n"; });
                }

                return {
                    content: [{
                        type: "text",
                        text: output.trim(),
                    }],
                };
            } catch (error) {
                return createErrorResponse(error instanceof Error ? error.message : String(error));
            }
        }
    );
}
