type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  formatted: string;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";
const LOG_BUFFER_LIMIT = 2_000;
const logBuffer: LogEntry[] = [];

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function record(level: LogLevel, msg: string): string {
  const timestamp = new Date().toISOString();
  const formatted = `${timestamp} [${level.toUpperCase()}] ${msg}`;
  logBuffer.push({ timestamp, level, message: msg, formatted });
  if (logBuffer.length > LOG_BUFFER_LIMIT) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_LIMIT);
  }
  return formatted;
}

export function getRecentLogs(limit = 400): LogEntry[] {
  return logBuffer.slice(-Math.max(0, limit));
}

export const log = {
  setLevel(level: LogLevel) {
    currentLevel = level;
  },
  debug(msg: string) {
    const formatted = record("debug", msg);
    if (shouldLog("debug")) console.debug(formatted);
  },
  info(msg: string) {
    const formatted = record("info", msg);
    if (shouldLog("info")) console.log(formatted);
  },
  warn(msg: string) {
    const formatted = record("warn", msg);
    if (shouldLog("warn")) console.warn(formatted);
  },
  error(msg: string) {
    const formatted = record("error", msg);
    if (shouldLog("error")) console.error(formatted);
  },
};
