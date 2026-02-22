// ============================================
// 로거
// ============================================

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;
const CURRENT_LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

export const logger = {
    debug: (msg: string, ...args: unknown[]) => {
        if (LOG_LEVELS[CURRENT_LOG_LEVEL] <= LOG_LEVELS.debug) console.error(`[DEBUG] ${msg}`, ...args);
    },
    info: (msg: string, ...args: unknown[]) => {
        if (LOG_LEVELS[CURRENT_LOG_LEVEL] <= LOG_LEVELS.info) console.error(`[INFO] ${msg}`, ...args);
    },
    warn: (msg: string, ...args: unknown[]) => {
        if (LOG_LEVELS[CURRENT_LOG_LEVEL] <= LOG_LEVELS.warn) console.error(`[WARN] ${msg}`, ...args);
    },
    error: (msg: string, ...args: unknown[]) => {
        if (LOG_LEVELS[CURRENT_LOG_LEVEL] <= LOG_LEVELS.error) console.error(`[ERROR] ${msg}`, ...args);
    },
};
