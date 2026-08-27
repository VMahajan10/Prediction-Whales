/**
 * Process-wide log level guard.
 *
 * Production emits WARN and ERROR only. DEBUG / INFO are suppressed unless
 * `DEBUG_LOGS=true`. Health, ping, and short-interval polling paths never emit
 * DEBUG / INFO telemetry (even in development) unless `DEBUG_LOGS=true`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const CONSOLE_METHOD: Record<LogLevel, "log" | "info" | "warn" | "error"> = {
  debug: "log",
  info: "info",
  warn: "warn",
  error: "error",
};

const HEALTH_PATHS = new Set([
  "/health",
  "/healthz",
  "/readyz",
  "/livez",
  "/ping",
  "/api/health",
  "/api/healthz",
  "/api/ready",
  "/api/ping",
]);

/** Short-interval client/server poll endpoints that otherwise flood logs. */
const POLL_PATHS = new Set([
  "/api/feed",
  "/api/feed/metrics",
  "/api/trades/recent",
  "/api/kalshi/trades",
  "/api/markets",
]);

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

export function isDebugLogsOverrideEnabled(): boolean {
  return process.env.DEBUG_LOGS === "true";
}

/** True when DEBUG-level logs are allowed (non-production, or DEBUG_LOGS=true). */
export function isDebugLoggingEnabled(): boolean {
  return !isProductionEnv() || isDebugLogsOverrideEnabled();
}

export function minEnabledLogLevel(): LogLevel {
  if (isDebugLogsOverrideEnabled()) return "debug";
  if (isProductionEnv()) return "warn";
  return "debug";
}

export function isLogLevelEnabled(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minEnabledLogLevel()];
}

export function normalizeRequestPath(pathname: string): string {
  const withoutQuery = pathname.split("?")[0] ?? pathname;
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return (trimmed || "/").toLowerCase();
}

export function isHealthOrPingPath(pathname: string): boolean {
  const path = normalizeRequestPath(pathname);
  if (HEALTH_PATHS.has(path)) return true;
  return (
    path.startsWith("/api/health/") ||
    path.startsWith("/health/") ||
    path.startsWith("/ping/")
  );
}

export function isPollingRequestPath(pathname: string): boolean {
  return POLL_PATHS.has(normalizeRequestPath(pathname));
}

/** Health checks, pings, and short-interval data polls. */
export function isRoutineRequestPath(pathname: string): boolean {
  return isHealthOrPingPath(pathname) || isPollingRequestPath(pathname);
}

export function shouldEmitLog(
  level: LogLevel,
  options?: { path?: string | null; routine?: boolean }
): boolean {
  const path = options?.path;
  const routine =
    options?.routine === true ||
    (typeof path === "string" && isRoutineRequestPath(path));

  if (routine && (level === "debug" || level === "info")) {
    return isDebugLogsOverrideEnabled();
  }

  return isLogLevelEnabled(level);
}

function writeLog(level: LogLevel, args: unknown[]): void {
  console[CONSOLE_METHOD[level]](...args);
}

export function log(level: LogLevel, ...args: unknown[]): void {
  if (!isLogLevelEnabled(level)) return;
  writeLog(level, args);
}

export function logForRequest(
  path: string | null | undefined,
  level: LogLevel,
  ...args: unknown[]
): void {
  if (!shouldEmitLog(level, { path })) return;
  writeLog(level, args);
}

export function logRoutine(level: LogLevel, ...args: unknown[]): void {
  if (!shouldEmitLog(level, { routine: true })) return;
  writeLog(level, args);
}

export const logger = {
  debug: (...args: unknown[]) => log("debug", ...args),
  info: (...args: unknown[]) => log("info", ...args),
  warn: (...args: unknown[]) => log("warn", ...args),
  error: (...args: unknown[]) => log("error", ...args),
  debugForPath: (path: string | null | undefined, ...args: unknown[]) =>
    logForRequest(path, "debug", ...args),
  infoForPath: (path: string | null | undefined, ...args: unknown[]) =>
    logForRequest(path, "info", ...args),
  routineDebug: (...args: unknown[]) => logRoutine("debug", ...args),
  routineInfo: (...args: unknown[]) => logRoutine("info", ...args),
};
