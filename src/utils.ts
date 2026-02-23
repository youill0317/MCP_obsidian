import * as fs from "fs/promises";
import * as path from "path";
import ignore, { Ignore } from "ignore";
import { MARKDOWN_EXTENSIONS, BASE_DIRS, PRIMARY_BASE_DIR } from "./config.js";
import { logger } from "./logger.js";

// ============================================
// 경로 유틸리티
// ============================================

/**
 * 입력 경로를 절대 경로로 정규화합니다.
 * - 절대 경로: 그대로 사용
 * - 상대 경로: BASE_DIR을 기준으로 해석
 */
export function normalizePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
        return path.resolve(inputPath);
    }
    return path.resolve(PRIMARY_BASE_DIR, inputPath);
}

/**
 * 경로가 허용된 BASE_DIRS 중 하나의 내부에 있는지 검증합니다.
 * 보안: 모든 허용 디렉토리 외부 접근을 차단합니다.
 */
export function isPathWithinBaseDir(normalizedPath: string): boolean {
    const resolvedPath = path.resolve(normalizedPath);
    const pathLower = resolvedPath.toLowerCase();

    return BASE_DIRS.some(baseDir => {
        const baseLower = path.resolve(baseDir).toLowerCase();
        // Windows에서 대소문자 무시
        return pathLower === baseLower || pathLower.startsWith(baseLower + path.sep);
    });
}

/**
 * 경로를 정규화하고 BASE_DIR 내부인지 검증합니다.
 * BASE_DIR 외부면 null을 반환합니다.
 */
export function normalizeAndValidatePath(inputPath: string): string | null {
    const normalized = normalizePath(inputPath);
    if (!isPathWithinBaseDir(normalized)) {
        return null;
    }
    return normalized;
}

// ============================================
// 에러 응답 헬퍼
// ============================================

/**
 * 에러 응답 생성 헬퍼
 */
export function createErrorResponse(message: string) {
    return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
    };
}

/**
 * BASE_DIR 외부 접근 시 에러 응답 생성
 */
export function accessDeniedError(inputPath: string) {
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
// 파일 유틸리티
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
// 퍼지 검색
// ============================================

/**
 * Levenshtein distance 기반 퍼지 매칭
 * 두 문자열 사이의 편집 거리를 계산합니다.
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
                dp[i - 1][j] + 1,      // 삭제
                dp[i][j - 1] + 1,      // 삽입
                dp[i - 1][j - 1] + cost // 치환
            );
        }
    }
    return dp[m][n];
}

/**
 * 퍼지 매칭: 텍스트 내에서 쿼리와 유사한 단어가 있는지 확인
 * 허용 거리 = max(1, floor(query길이 * 0.3))
 */
export function fuzzyMatch(text: string, query: string): boolean {
    const textLower = text.toLowerCase();
    const queryLower = query.toLowerCase();

    // 정확히 포함하면 무조건 매칭
    if (textLower.includes(queryLower)) return true;

    // 단어 단위로 비교
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
// 쿼리 유틸리티
// ============================================

/**
 * LLM이 여러 JSON 객체를 연결하여 보낸 경우 첫 번째 query만 추출.
 * 예: '{"query":"A"}{"query":"B"}' → 'A'
 * 정상 입력은 그대로 반환.
 */
export function sanitizeQuery(input: string): string {
    const trimmed = input.trim();
    // 패턴: {"query":"..."}...{ 형태 감지
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
// .gitignore 유틸리티
// ============================================

/**
 * .gitignore 파일들을 읽어서 ignore 인스턴스 생성
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
// 마크다운 유틸리티
// ============================================

/**
 * YAML 파서 캐싱 (동적 import 오버헤드 제거)
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
 * YAML 프론트매터 파싱
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
 * 프론트매터 이후의 본문만 추출
 */
export function extractBody(content: string): string {
    const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
    return content.replace(frontmatterRegex, "").trim();
}
