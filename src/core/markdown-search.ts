import * as fs from "fs/promises";
import * as path from "path";
import { MAX_RESULTS } from "../config.js";
import { logger } from "../logger.js";
import {
    exists,
    fuzzyMatch,
    isMarkdownFile,
    loadGitignore,
    parseFrontmatter,
    sanitizeQuery,
} from "../utils.js";

export type SearchMatchType = "filename" | "tag" | "content";

export interface SearchLineMatch {
    line: number;
    text: string;
}

export interface MarkdownSearchResult {
    path: string;
    relativePath: string;
    fileName: string;
    matchTypes: SearchMatchType[];
    tags: string[];
    contentMatches: SearchLineMatch[];
    score: number;
}

export interface CollectMarkdownFilesOptions {
    rootDir: string;
    respectGitignore?: boolean;
    maxFiles?: number;
}

export interface SearchMarkdownFilesOptions {
    rootDir: string;
    query: string;
    maxResults?: number;
    respectGitignore?: boolean;
    useRegex?: boolean;
    fuzzy?: boolean;
    tag?: string;
    filenamePattern?: string;
    frontmatterFilter?: Record<string, string>;
    modifiedAfter?: Date | null;
    modifiedBefore?: Date | null;
    contentSampleBytes?: number;
    contentMatchLimit?: number;
    readFullContent?: boolean;
    batchSize?: number;
}

export interface SearchMarkdownFilesResult {
    normalizedQuery: string;
    contentScannedMode: "full" | "sampled";
    results: MarkdownSearchResult[];
}

function compileFilenamePattern(filenamePattern?: string): RegExp | null {
    if (!filenamePattern) {
        return null;
    }

    const regexPattern = filenamePattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");

    return new RegExp(`^${regexPattern}$`, "i");
}

async function readFileSample(filePath: string, sampleBytes: number): Promise<string> {
    if (sampleBytes <= 0) {
        return "";
    }

    const fileHandle = await fs.open(filePath, "r");
    try {
        const buffer = Buffer.alloc(sampleBytes);
        const { bytesRead } = await fileHandle.read(buffer, 0, sampleBytes, 0);
        return buffer.toString("utf8", 0, bytesRead);
    } finally {
        await fileHandle.close();
    }
}

async function readStrategicSample(filePath: string, sampleBytes: number): Promise<string> {
    if (sampleBytes <= 0) {
        return "";
    }

    const fileStat = await fs.stat(filePath);
    if (fileStat.size <= sampleBytes) {
        return fs.readFile(filePath, "utf8");
    }

    const segmentSize = Math.max(256, Math.floor(sampleBytes / 3));
    const middleStart = Math.max(0, Math.floor(fileStat.size / 2) - Math.floor(segmentSize / 2));
    const tailStart = Math.max(0, fileStat.size - segmentSize);

    const starts = [0, middleStart, tailStart];
    const fileHandle = await fs.open(filePath, "r");
    try {
        const chunks: string[] = [];
        for (const start of starts) {
            const buffer = Buffer.alloc(segmentSize);
            const { bytesRead } = await fileHandle.read(buffer, 0, segmentSize, start);
            chunks.push(buffer.toString("utf8", 0, bytesRead));
        }
        return chunks.join("\n");
    } finally {
        await fileHandle.close();
    }
}

function buildMatcher(
    normalizedQuery: string,
    useRegex: boolean,
    fuzzy: boolean
): (text: string) => boolean {
    if (useRegex) {
        const regex = new RegExp(normalizedQuery, "i");
        return (text: string) => regex.test(text);
    }

    if (fuzzy) {
        return (text: string) => fuzzyMatch(text, normalizedQuery);
    }

    const loweredQuery = normalizedQuery.toLowerCase();
    return (text: string) => text.toLowerCase().includes(loweredQuery);
}

export async function collectMarkdownFiles({
    rootDir,
    respectGitignore = true,
    maxFiles,
}: CollectMarkdownFilesOptions): Promise<string[]> {
    const normalizedRootDir = path.resolve(rootDir);
    if (!(await exists(normalizedRootDir))) {
        return [];
    }

    const files: string[] = [];
    const ig = respectGitignore ? await loadGitignore(normalizedRootDir) : null;

    async function walk(currentDir: string): Promise<void> {
        if (maxFiles !== undefined && files.length >= maxFiles) {
            return;
        }

        let entries;
        try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
        } catch (error) {
            logger.debug(`Failed to read directory: ${currentDir}`, error);
            return;
        }

        entries.sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) {
                return a.isDirectory() ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
            if (maxFiles !== undefined && files.length >= maxFiles) {
                return;
            }

            const fullPath = path.join(currentDir, entry.name);
            const relativePath = path.relative(normalizedRootDir, fullPath);

            if (ig && ig.ignores(relativePath)) {
                continue;
            }

            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }

            if (entry.isFile() && isMarkdownFile(entry.name)) {
                files.push(fullPath);
            }
        }
    }

    await walk(normalizedRootDir);
    return files;
}

export async function searchMarkdownFiles({
    rootDir,
    query,
    maxResults = 10,
    respectGitignore = true,
    useRegex = false,
    fuzzy = false,
    tag,
    filenamePattern,
    frontmatterFilter,
    modifiedAfter = null,
    modifiedBefore = null,
    contentSampleBytes = 8192,
    contentMatchLimit = 3,
    readFullContent = false,
    batchSize = 10,
}: SearchMarkdownFilesOptions): Promise<SearchMarkdownFilesResult> {
    if (useRegex && fuzzy) {
        throw new Error("fuzzy and useRegex cannot be enabled together.");
    }

    const normalizedQuery = sanitizeQuery(query);
    if (!normalizedQuery || normalizedQuery.trim().length === 0) {
        throw new Error("query must be a non-empty string.");
    }

    const clampedMaxResults = Math.min(Math.max(1, maxResults), MAX_RESULTS);
    const normalizedRootDir = path.resolve(rootDir);
    const filenameRegex = compileFilenamePattern(filenamePattern);
    const matcher = buildMatcher(normalizedQuery, useRegex, fuzzy);
    const tagLower = tag?.toLowerCase();
    const maxContentMatches = Math.max(1, contentMatchLimit);
    const fileBatchSize = Math.max(1, batchSize);

    const files = await collectMarkdownFiles({
        rootDir: normalizedRootDir,
        respectGitignore,
    });

    const collectedResults: MarkdownSearchResult[] = [];

    async function inspectFile(filePath: string): Promise<void> {
        const fileName = path.basename(filePath);
        if (filenameRegex && !filenameRegex.test(fileName)) {
            return;
        }

        if (modifiedAfter || modifiedBefore) {
            try {
                const fileStat = await fs.stat(filePath);
                if (modifiedAfter && fileStat.mtime < modifiedAfter) return;
                if (modifiedBefore && fileStat.mtime > modifiedBefore) return;
            } catch (error) {
                logger.debug(`Failed to stat file: ${filePath}`, error);
                return;
            }
        }

        const result: MarkdownSearchResult = {
            path: filePath,
            relativePath: path.relative(normalizedRootDir, filePath),
            fileName,
            matchTypes: [],
            tags: [],
            contentMatches: [],
            score: 0,
        };

        if (matcher(fileName)) {
            result.matchTypes.push("filename");
            result.score += 10;
        }

        try {
            const content = readFullContent
                ? await fs.readFile(filePath, "utf8")
                : await readStrategicSample(filePath, contentSampleBytes);

            const metadata = await parseFrontmatter(content);
            if (frontmatterFilter && Object.keys(frontmatterFilter).length > 0) {
                if (!metadata) return;
                for (const [key, value] of Object.entries(frontmatterFilter)) {
                    const metadataValue = metadata[key];
                    if (metadataValue === undefined || metadataValue === null) return;
                    if (!String(metadataValue).toLowerCase().includes(value.toLowerCase())) return;
                }
            }

            const metadataTags = metadata?.tags && Array.isArray(metadata.tags)
                ? metadata.tags.map((tagValue) => String(tagValue))
                : [];

            if (tagLower) {
                const filteredTagMatches = metadataTags.filter((tagValue) =>
                    tagValue.toLowerCase().includes(tagLower)
                );
                if (filteredTagMatches.length === 0) {
                    return;
                }
                result.tags = filteredTagMatches;
            }

            const queryTagMatches = metadataTags.filter((tagValue) => matcher(tagValue));
            if (queryTagMatches.length > 0) {
                result.matchTypes.push("tag");
                result.tags = queryTagMatches;
                result.score += 8;
            }

            const lines = content.split(/\r?\n/);
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                if (result.contentMatches.length >= maxContentMatches) {
                    break;
                }
                const line = lines[lineIndex];
                if (!matcher(line)) {
                    continue;
                }

                result.contentMatches.push({
                    line: lineIndex + 1,
                    text: line.trim().substring(0, 100),
                });
            }

            if (result.contentMatches.length > 0) {
                result.matchTypes.push("content");
                result.score += result.contentMatches.length * 2;
            }
        } catch (error) {
            logger.debug(`Failed to inspect file: ${filePath}`, error);
        }

        if (result.matchTypes.length > 0) {
            collectedResults.push(result);
        }
    }

    for (let index = 0; index < files.length; index += fileBatchSize) {
        if (collectedResults.length >= clampedMaxResults * 2) {
            break;
        }
        const batch = files.slice(index, index + fileBatchSize);
        await Promise.allSettled(batch.map((filePath) => inspectFile(filePath)));
    }

    collectedResults.sort((left, right) => {
        if (right.score !== left.score) {
            return right.score - left.score;
        }
        return left.path.localeCompare(right.path);
    });

    return {
        normalizedQuery,
        contentScannedMode: readFullContent ? "full" : "sampled",
        results: collectedResults.slice(0, clampedMaxResults),
    };
}
