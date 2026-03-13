import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import ignore, { Ignore } from "ignore";
import { MARKDOWN_EXTENSIONS, BASE_DIRS, PRIMARY_BASE_DIR } from "./config.js";
import { logger } from "./logger.js";

export interface BaseDirInfo {
    resolvedPath: string;
    canonicalPath: string;
    isHiddenBase: boolean;
}

export interface PathAccessInfo {
    matchedBaseDir: BaseDirInfo | null;
    isWithinBaseDir: boolean;
    isDotPrefixedDirectory: boolean;
}

function normalizeForComparison(targetPath: string): string {
    return process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const parentComparable = normalizeForComparison(path.resolve(parentPath));
    const childComparable = normalizeForComparison(path.resolve(childPath));
    return childComparable === parentComparable || childComparable.startsWith(parentComparable + path.sep);
}

function isDotPrefixedName(name: string): boolean {
    return name.startsWith(".") && name !== "." && name !== "..";
}

function resolveCanonicalPath(targetPath: string): string {
    const resolvedPath = path.resolve(targetPath);
    const suffixSegments: string[] = [];
    let existingPath = resolvedPath;

    while (!fsSync.existsSync(existingPath)) {
        const parentPath = path.dirname(existingPath);
        if (parentPath === existingPath) {
            break;
        }

        suffixSegments.unshift(path.basename(existingPath));
        existingPath = parentPath;
    }

    let canonicalBasePath = existingPath;
    try {
        canonicalBasePath = fsSync.realpathSync.native(existingPath);
    } catch {
        canonicalBasePath = existingPath;
    }

    return suffixSegments.length > 0
        ? path.join(canonicalBasePath, ...suffixSegments)
        : canonicalBasePath;
}

function createBaseDirInfo(baseDir: string): BaseDirInfo {
    const resolvedPath = path.resolve(baseDir);
    const canonicalPath = resolveCanonicalPath(resolvedPath);

    return {
        resolvedPath,
        canonicalPath,
        isHiddenBase:
            isDotPrefixedName(path.basename(resolvedPath)) ||
            isDotPrefixedName(path.basename(canonicalPath)),
    };
}

function getMatchedBaseDirInfo(normalizedPath: string, baseDirs: string[]): BaseDirInfo | null {
    const canonicalPath = resolveCanonicalPath(normalizedPath);
    const matches = baseDirs
        .map(createBaseDirInfo)
        .filter((baseDirInfo) => isPathInside(baseDirInfo.canonicalPath, canonicalPath))
        .sort((left, right) => right.canonicalPath.length - left.canonicalPath.length);

    return matches[0] ?? null;
}

export function getPathAccessInfo(normalizedPath: string, baseDirs: string[] = BASE_DIRS): PathAccessInfo {
    const canonicalPath = resolveCanonicalPath(normalizedPath);
    const matchedBaseDir = getMatchedBaseDirInfo(normalizedPath, baseDirs);

    if (!matchedBaseDir) {
        return {
            matchedBaseDir: null,
            isWithinBaseDir: false,
            isDotPrefixedDirectory: false,
        };
    }

    if (matchedBaseDir.isHiddenBase) {
        return {
            matchedBaseDir,
            isWithinBaseDir: true,
            isDotPrefixedDirectory: true,
        };
    }

    const relativePath = path.relative(matchedBaseDir.canonicalPath, canonicalPath);
    if (!relativePath) {
        return {
            matchedBaseDir,
            isWithinBaseDir: true,
            isDotPrefixedDirectory: false,
        };
    }

    const segments = relativePath.split(path.sep).filter((segment) => segment.length > 0);
    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        if (!isDotPrefixedName(segment)) {
            continue;
        }

        const isLastSegment = index === segments.length - 1;
        if (!isLastSegment) {
            return {
                matchedBaseDir,
                isWithinBaseDir: true,
                isDotPrefixedDirectory: true,
            };
        }

        try {
            return {
                matchedBaseDir,
                isWithinBaseDir: true,
                isDotPrefixedDirectory: fsSync.statSync(normalizedPath).isDirectory(),
            };
        } catch {
            return {
                matchedBaseDir,
                isWithinBaseDir: true,
                isDotPrefixedDirectory: !isMarkdownFile(segment),
            };
        }
    }

    return {
        matchedBaseDir,
        isWithinBaseDir: true,
        isDotPrefixedDirectory: false,
    };
}

// ============================================
// Path utilities
// ============================================

/**
 * Normalize an input path to an absolute path.
 * - Absolute paths are preserved.
 * - Relative paths are resolved from the primary base dir.
 */
export function normalizePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
        return path.resolve(inputPath);
    }
    return path.resolve(PRIMARY_BASE_DIR, inputPath);
}

export function validatePathAgainstBaseDirs(
    inputPath: string,
    baseDirs: string[],
    primaryBaseDir: string = baseDirs[0] ?? process.cwd()
): string | null {
    const normalizedPath = path.isAbsolute(inputPath)
        ? path.resolve(inputPath)
        : path.resolve(primaryBaseDir, inputPath);
    const accessInfo = getPathAccessInfo(normalizedPath, baseDirs);

    if (!accessInfo.isWithinBaseDir || accessInfo.isDotPrefixedDirectory) {
        return null;
    }

    return normalizedPath;
}

/**
 * Check whether the path resolves inside one of the configured base dirs.
 */
export function isPathWithinBaseDir(normalizedPath: string): boolean {
    return getPathAccessInfo(normalizedPath).isWithinBaseDir;
}

export function isDotPrefixedDirectoryPath(normalizedPath: string): boolean {
    return getPathAccessInfo(normalizedPath).isDotPrefixedDirectory;
}

/**
 * Normalize and validate a path against the configured base dirs.
 * Returns null for paths outside the base dirs or blocked hidden directories.
 */
export function normalizeAndValidatePath(inputPath: string): string | null {
    return validatePathAgainstBaseDirs(inputPath, BASE_DIRS, PRIMARY_BASE_DIR);
}

// ============================================
// Error helpers
// ============================================

/**
 * Build a standard error payload for MCP tool responses.
 */
export function createErrorResponse(message: string) {
    return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
    };
}

/**
 * Build an access denied response for hidden directories or out-of-base paths.
 */
export function accessDeniedError(inputPath: string) {
    const normalizedPath = normalizePath(inputPath);
    const accessInfo = getPathAccessInfo(normalizedPath);
    if (accessInfo.isWithinBaseDir && accessInfo.isDotPrefixedDirectory) {
        return createErrorResponse(
            `Access denied: hidden/dot-prefixed directories are not allowed: "${inputPath}".`
        );
    }

    const allowedDirs = BASE_DIRS.join(", ");
    return createErrorResponse(
        `Access denied: "${inputPath}" is outside the allowed directories (${allowedDirs}).`
    );
}

export function pathNotFoundError(normalizedPath: string) {
    return createErrorResponse(`Path not found: ${normalizedPath}`);
}

export function notDirectoryError(normalizedPath: string) {
    return createErrorResponse(`Not a directory: ${normalizedPath}`);
}

export function notMarkdownError(normalizedPath: string) {
    return createErrorResponse(`Not a markdown file: ${normalizedPath}`);
}

// ============================================
// File utilities
// ============================================

export async function exists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

export function formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isMarkdownFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return MARKDOWN_EXTENSIONS.includes(ext);
}

// ============================================
// Fuzzy search
// ============================================

/**
 * Compute Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }
    return dp[m][n];
}

/**
 * Check whether text contains a word similar to the query.
 */
export function fuzzyMatch(text: string, query: string): boolean {
    const textLower = text.toLowerCase();
    const queryLower = query.toLowerCase();

    if (textLower.includes(queryLower)) return true;

    const maxDist = Math.max(1, Math.floor(queryLower.length * 0.3));
    const words = textLower.split(/[\s\-_.,;:!?()\[\]{}"'`\/\\]+/).filter(w => w.length > 0);

    for (const word of words) {
        if (levenshteinDistance(word, queryLower) <= maxDist) {
            return true;
        }
    }
    return false;
}

// ============================================
// Query utilities
// ============================================

/**
 * If an LLM concatenates multiple JSON objects, extract the first query field.
 * Example: '{"query":"A"}{"query":"B"}' -> 'A'
 */
export function sanitizeQuery(input: string): string {
    const trimmed = input.trim();
    if (trimmed.includes('"}') && trimmed.includes('{"')) {
        const multiJsonPattern = /^\s*\{[^}]*"query"\s*:\s*"([^"]+)"[^}]*\}/;
        const match = trimmed.match(multiJsonPattern);
        if (match) {
            return match[1];
        }
    }
    return trimmed;
}

// ============================================
// .gitignore utilities
// ============================================

/**
 * Load .gitignore files from the current directory up to the filesystem root.
 */
export async function loadGitignore(directory: string): Promise<Ignore> {
    const ig = ignore();
    ig.add(["node_modules", ".git", ".svn", "__pycache__", "dist", "build", ".DS_Store", ".obsidian"]);

    let currentDir = directory;
    const gitignoreFiles: string[] = [];

    while (currentDir !== path.dirname(currentDir)) {
        const gitignorePath = path.join(currentDir, ".gitignore");
        if (await exists(gitignorePath)) {
            gitignoreFiles.unshift(gitignorePath);
        }
        currentDir = path.dirname(currentDir);
    }

    for (const gitignorePath of gitignoreFiles) {
        try {
            const content = await fs.readFile(gitignorePath, "utf8");
            ig.add(content);
        } catch (e) {
            logger.debug(`Failed to read .gitignore: ${gitignorePath}`, e);
        }
    }

    return ig;
}

// ============================================
// Markdown utilities
// ============================================

/**
 * Cache the YAML parser to avoid repeated dynamic-import overhead.
 */
let yamlParser: { parse: (str: string) => Record<string, unknown> } | null = null;

export async function getYamlParser() {
    if (!yamlParser) {
        const yamlModule = await import("yaml");
        yamlParser = yamlModule.default || yamlModule;
    }
    return yamlParser;
}

/**
 * Parse YAML frontmatter from markdown content.
 */
export async function parseFrontmatter(content: string): Promise<Record<string, unknown> | null> {
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
    const match = content.match(frontmatterRegex);

    if (!match) return null;

    try {
        const yaml = await getYamlParser();
        return yaml.parse(match[1]) || {};
    } catch {
        return null;
    }
}

/**
 * Extract the markdown body after frontmatter.
 */
export function extractBody(content: string): string {
    const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
    return content.replace(frontmatterRegex, "").trim();
}
