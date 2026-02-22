import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs/promises";
import * as path from "path";
import { Ignore } from "ignore";
import { BASE_DIRS } from "../config.js";
import { logger } from "../logger.js";
import { isMarkdownFile, loadGitignore, parseFrontmatter } from "../utils.js";

export function registerVaultContext(server: McpServer) {
    server.resource(
        "vault-context",
        "mcp://markdown-explorer-mcp/vault-context",
        async (uri) => {
            try {
                // 1. 최상위 폴더 구조 (모든 BASE_DIRS에서 수집)
                const topLevelDirs: string[] = [];
                const topLevelFiles: string[] = [];

                for (const baseDir of BASE_DIRS) {
                    try {
                        const ig = await loadGitignore(baseDir);
                        const entries = await fs.readdir(baseDir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (entry.name.startsWith(".")) continue;
                            if (ig.ignores(entry.name)) continue;

                            if (entry.isDirectory()) {
                                topLevelDirs.push(`[${path.basename(baseDir)}] ${entry.name}`);
                            } else if (isMarkdownFile(entry.name)) {
                                topLevelFiles.push(`[${path.basename(baseDir)}] ${entry.name}`);
                            }
                        }
                    } catch (e) {
                        logger.debug(`vault-context: 디렉토리 읽기 실패: ${baseDir}`, e);
                    }
                }

                // 2. 최근 수정된 파일 (최대 10개)
                interface FileInfo {
                    path: string;
                    mtime: Date;
                }
                const recentFiles: FileInfo[] = [];

                async function collectRecentFiles(baseDir: string, dir: string, ig: Ignore, depth: number): Promise<void> {
                    if (depth > 5 || recentFiles.length >= 50) return;

                    try {
                        const entries = await fs.readdir(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            const relativePath = path.relative(baseDir, fullPath);

                            if (entry.name.startsWith(".")) continue;
                            if (ig.ignores(relativePath)) continue;

                            if (entry.isDirectory()) {
                                await collectRecentFiles(baseDir, fullPath, ig, depth + 1);
                            } else if (isMarkdownFile(entry.name)) {
                                try {
                                    const stats = await fs.stat(fullPath);
                                    recentFiles.push({ path: `[${path.basename(baseDir)}] ${relativePath}`, mtime: stats.mtime });
                                } catch (e) {
                                    logger.debug(`vault-context: 파일 stat 실패: ${fullPath}`, e);
                                }
                            }
                        }
                    } catch (e) {
                        logger.debug(`vault-context: 디렉토리 순회 실패: ${dir}`, e);
                    }
                }

                for (const baseDir of BASE_DIRS) {
                    const ig = await loadGitignore(baseDir);
                    await collectRecentFiles(baseDir, baseDir, ig, 0);
                }
                recentFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
                const topRecentFiles = recentFiles.slice(0, 10).map(f => f.path);

                // 3. 인기 태그 (최대 15개)
                const tagCounts = new Map<string, number>();

                async function collectTags(baseDir: string, dir: string, ig: Ignore, depth: number): Promise<void> {
                    if (depth > 5 || tagCounts.size >= 100) return;

                    try {
                        const entries = await fs.readdir(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            const relativePath = path.relative(baseDir, fullPath);

                            if (entry.name.startsWith(".")) continue;
                            if (ig.ignores(relativePath)) continue;

                            if (entry.isDirectory()) {
                                await collectTags(baseDir, fullPath, ig, depth + 1);
                            } else if (isMarkdownFile(entry.name)) {
                                try {
                                    const fileHandle = await fs.open(fullPath, "r");
                                    const buffer = Buffer.alloc(2048);
                                    const { bytesRead } = await fileHandle.read(buffer, 0, 2048, 0);
                                    await fileHandle.close();
                                    const content = buffer.toString("utf8", 0, bytesRead);

                                    const metadata = await parseFrontmatter(content);
                                    if (metadata?.tags && Array.isArray(metadata.tags)) {
                                        for (const tag of metadata.tags) {
                                            const tagStr = String(tag).toLowerCase();
                                            tagCounts.set(tagStr, (tagCounts.get(tagStr) || 0) + 1);
                                        }
                                    }
                                } catch (e) {
                                    logger.debug(`vault-context: 파일 읽기 실패: ${fullPath}`, e);
                                }
                            }
                        }
                    } catch (e) {
                        logger.debug(`vault-context: 디렉토리 순회 실패: ${dir}`, e);
                    }
                }

                for (const baseDir of BASE_DIRS) {
                    const ig = await loadGitignore(baseDir);
                    await collectTags(baseDir, baseDir, ig, 0);
                }
                const topTags = Array.from(tagCounts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 15)
                    .map(([tag, count]) => ({ tag, count }));

                // 4. 통계
                const stats = {
                    totalFolders: topLevelDirs.length,
                    totalRecentFiles: recentFiles.length,
                    totalTags: tagCounts.size,
                };

                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: "application/json",
                        text: JSON.stringify({
                            baseDirs: BASE_DIRS,
                            structure: {
                                folders: topLevelDirs.slice(0, 20),
                                rootFiles: topLevelFiles.slice(0, 10),
                            },
                            recentFiles: topRecentFiles,
                            topTags,
                            stats,
                            tips: [
                                "search_markdown: 파일명/태그/내용을 한 번에 검색",
                                "read_markdown_full(query='...'): 검색 후 바로 읽기",
                                "read_markdown_section(header='...'): 전체에서 헤더 검색",
                            ],
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: "text/plain",
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                    }],
                };
            }
        }
    );
}
