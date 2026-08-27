import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDebugLoggingEnabled,
  isLogLevelEnabled,
  isRoutineRequestPath,
  logger,
  shouldEmitLog,
} from "@/lib/logger";

describe("logger", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDebugLogs = process.env.DEBUG_LOGS;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalDebugLogs === undefined) {
      delete process.env.DEBUG_LOGS;
    } else {
      process.env.DEBUG_LOGS = originalDebugLogs;
    }
    vi.restoreAllMocks();
  });

  it("suppresses debug and info in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.DEBUG_LOGS;

    expect(isDebugLoggingEnabled()).toBe(false);
    expect(isLogLevelEnabled("debug")).toBe(false);
    expect(isLogLevelEnabled("info")).toBe(false);
    expect(isLogLevelEnabled("warn")).toBe(true);
    expect(isLogLevelEnabled("error")).toBe(true);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.debug("debug-noise");
    logger.info("info-noise");
    logger.warn("keep-warn");
    logger.error("keep-error");

    expect(logSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("keep-warn");
    expect(errorSpy).toHaveBeenCalledWith("keep-error");
  });

  it("allows debug and info outside production", () => {
    process.env.NODE_ENV = "development";
    delete process.env.DEBUG_LOGS;

    expect(isDebugLoggingEnabled()).toBe(true);
    expect(isLogLevelEnabled("debug")).toBe(true);
    expect(isLogLevelEnabled("info")).toBe(true);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.debug("dev-debug");
    expect(logSpy).toHaveBeenCalledWith("dev-debug");
  });

  it("re-enables debug/info in production when DEBUG_LOGS=true", () => {
    process.env.NODE_ENV = "production";
    process.env.DEBUG_LOGS = "true";

    expect(isDebugLoggingEnabled()).toBe(true);
    expect(isLogLevelEnabled("debug")).toBe(true);
    expect(shouldEmitLog("debug", { path: "/api/feed" })).toBe(true);
  });

  it("identifies health, ping, and polling paths as routine", () => {
    expect(isRoutineRequestPath("/api/health")).toBe(true);
    expect(isRoutineRequestPath("/healthz")).toBe(true);
    expect(isRoutineRequestPath("/ping")).toBe(true);
    expect(isRoutineRequestPath("/api/feed?x=1")).toBe(true);
    expect(isRoutineRequestPath("/api/trades/recent")).toBe(true);
    expect(isRoutineRequestPath("/api/kalshi/trades")).toBe(true);
    expect(isRoutineRequestPath("/api/ev/trades")).toBe(false);
  });

  it("suppresses debug/info for routine polling even in development", () => {
    process.env.NODE_ENV = "development";
    delete process.env.DEBUG_LOGS;

    expect(shouldEmitLog("debug", { path: "/api/feed" })).toBe(false);
    expect(shouldEmitLog("info", { routine: true })).toBe(false);
    expect(shouldEmitLog("warn", { path: "/api/feed" })).toBe(true);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.debugForPath("/api/trades/recent", "poll-noise");
    logger.routineDebug("heartbeat");
    expect(logSpy).not.toHaveBeenCalled();
  });
});
