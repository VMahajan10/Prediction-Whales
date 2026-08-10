import { afterEach, describe, expect, it } from "vitest";
import { isVerboseXAgentLoggingEnabled } from "@/lib/x-agent/verboseLogging";

describe("isVerboseXAgentLoggingEnabled", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDebugLogs = process.env.DEBUG_LOGS;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.DEBUG_LOGS = originalDebugLogs;
  });

  it("is disabled in production unless DEBUG_LOGS=true", () => {
    process.env.NODE_ENV = "production";
    delete process.env.DEBUG_LOGS;
    expect(isVerboseXAgentLoggingEnabled()).toBe(false);

    process.env.DEBUG_LOGS = "true";
    expect(isVerboseXAgentLoggingEnabled()).toBe(true);
  });

  it("is enabled outside production", () => {
    process.env.NODE_ENV = "development";
    delete process.env.DEBUG_LOGS;
    expect(isVerboseXAgentLoggingEnabled()).toBe(true);
  });
});
