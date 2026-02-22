import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import {
    normalizeAndValidatePath, accessDeniedError, createErrorResponse,
    pathNotFoundError, notMarkdownError, exists, isMarkdownFile,
} from "../utils.js";

export function registerLinkedFiles(server: McpServer) {
    server.tool(
        "get_linked_files",
        "Extract links, wiki links, images, and embeds from a markdown file. Optionally check whether targets exist. Example: {\"path\":\"README.md\",\"type\":\"markdown\"}.",
        {
            path: z.string().describe("Markdown file path."),
            type: z.enum(["all", "markdown", "image", "external", "embed"]).optional().default("all").describe("Filter: all | markdown | image | external | embed."),
            checkExists: z.boolean().optional().default(false).describe("If true, verify link targets exist (relative paths are resolved from the file; slower)."),
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

                async function checkLinkTargetExists(linkInfo: LinkInfo, unresolvedPath: string): Promise<void> {
                    const resolvedPath = path.resolve(fileDir, unresolvedPath);
                    const validatedPath = normalizeAndValidatePath(resolvedPath);

                    if (validatedPath === null) {
                        linkInfo.outsideBaseDir = true;
                        linkInfo.exists = false;
                        return;
                    }

                    linkInfo.resolvedPath = validatedPath;
                    linkInfo.exists = await exists(validatedPath);
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

                    // 일반 마크다운 링크
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

                    // 위키 링크
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
                                const wikiPath = target.endsWith(".md") ? target : `${target}.md`;
                                await checkLinkTargetExists(linkInfo, wikiPath);
                            }

                            links.push(linkInfo);
                        }
                    }

                    // 임베드
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

                    // 이미지
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
                                ? "링크를 찾을 수 없습니다."
                                : `"${type}" 타입의 링크를 찾을 수 없습니다.`,
                        }],
                    };
                }

                // 타입별로 그룹화
                const grouped = {
                    markdown: links.filter(l => l.type === "markdown"),
                    image: links.filter(l => l.type === "image"),
                    external: links.filter(l => l.type === "external"),
                    embed: links.filter(l => l.type === "embed"),
                };

                let output = `링크 (${links.length}개 발견):\n\n`;

                const formatLink = (l: LinkInfo) => {
                    const status = checkExists
                        ? (l.outsideBaseDir ? "[OUTSIDE]" : (l.exists ? "[O]" : "[X]"))
                        : "•";
                    const displayTarget = l.type === "markdown" && !l.target.includes("/") ? `[[${l.target}]]` : l.target;
                    const reason = l.outsideBaseDir ? " (BASE_DIR 외부)" : "";
                    return `  ${status} L${l.line}: ${displayTarget}${l.text ? ` (${l.text})` : ""}${reason}`;
                };

                if (grouped.markdown.length > 0) {
                    output += `[마크다운] (${grouped.markdown.length}개):\n`;
                    grouped.markdown.forEach(l => output += formatLink(l) + "\n");
                    output += "\n";
                }

                if (grouped.image.length > 0) {
                    output += `[이미지] (${grouped.image.length}개):\n`;
                    grouped.image.forEach(l => output += formatLink(l) + "\n");
                    output += "\n";
                }

                if (grouped.external.length > 0) {
                    output += `[외부] (${grouped.external.length}개):\n`;
                    grouped.external.forEach(l => output += formatLink(l) + "\n");
                    output += "\n";
                }

                if (grouped.embed.length > 0) {
                    output += `[임베드] (${grouped.embed.length}개):\n`;
                    grouped.embed.forEach(l => output += formatLink(l) + "\n");
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
