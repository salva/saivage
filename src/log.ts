type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function fmt(level: LogLevel, msg: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${level.toUpperCase()}] ${msg}`;
}

export const log = {
  setLevel(level: LogLevel) {
    currentLevel = level;
  },
  debug(msg: string) {
    if (shouldLog("debug")) console.debug(fmt("debug", msg));
  },
  info(msg: string) {
    if (shouldLog("info")) console.log(fmt("info", msg));
  },
  warn(msg: string) {
    if (shouldLog("warn")) console.warn(fmt("warn", msg));
  },
  error(msg: string) {
    if (shouldLog("error")) console.error(fmt("error", msg));
  },
};
