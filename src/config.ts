import * as path from "path";

// ============================================
// 상수 정의
// ============================================

export const MARKDOWN_EXTENSIONS = [".md", ".mdx", ".markdown"];

// 안정성 상수
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_DEPTH = 20;
export const MAX_RESULTS = 50;
export const MAX_PATHS = 20;

/**
 * Base 디렉토리 설정
 * 환경변수 MARKDOWN_BASE_DIR이 설정되면 상대 경로는 이 디렉토리를 기준으로 해석됩니다.
 * 세미콜론(;)으로 구분하여 여러 디렉토리를 지정할 수 있습니다.
 * 예: "C:\Vault1;C:\Vault2;C:\Vault3"
 * 첫 번째 경로가 상대 경로 해석의 기본 기준이 됩니다.
 * 설정되지 않으면 MCP 서버의 현재 작업 디렉토리(cwd)를 사용합니다.
 */
const parsedBaseDirs = process.env.MARKDOWN_BASE_DIR
    ? process.env.MARKDOWN_BASE_DIR
        .split(";")
        .map(d => d.trim())
        .filter(d => d.length > 0)
        .map(d => path.resolve(d))
    : [];

export const BASE_DIRS: string[] = parsedBaseDirs.length > 0
    ? parsedBaseDirs
    : [process.cwd()];

/** 첫 번째 BASE_DIR (상대 경로 해석 기준) */
export const PRIMARY_BASE_DIR = BASE_DIRS[0];
