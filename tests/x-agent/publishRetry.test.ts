import { describe, expect, it } from "vitest";
import {
  MAX_PUBLISH_RETRIES,
  RATE_LIMIT_BACKOFF_MS,
  parseTwitterPublishError,
  resolvePublishFailureAction,
  resolvePublishRetryBackoffMs,
} from "@/lib/x-agent/publishRetry";

describe("parseTwitterPublishError", () => {
  it("detects HTTP 429 rate limits", () => {
    const parsed = parseTwitterPublishError({ code: 429, message: "Too Many Requests" });
    expect(parsed.rateLimited).toBe(true);
    expect(parsed.retryable).toBe(true);
    expect(parsed.statusCode).toBe(429);
  });

  it("marks 403 as non-retryable", () => {
    const parsed = parseTwitterPublishError({
      code: 403,
      message: "Forbidden",
    });
    expect(parsed.retryable).toBe(false);
  });
});

describe("resolvePublishFailureAction", () => {
  it("always reschedules rate-limited failures", () => {
    expect(
      resolvePublishFailureAction(MAX_PUBLISH_RETRIES, {
        rateLimited: true,
        retryable: true,
      })
    ).toBe("reschedule");
  });

  it("fails after max retries for retryable non-429 errors", () => {
    expect(
      resolvePublishFailureAction(MAX_PUBLISH_RETRIES - 1, {
        rateLimited: false,
        retryable: true,
      })
    ).toBe("fail");
  });

  it("reschedules before max retries", () => {
    expect(
      resolvePublishFailureAction(0, {
        rateLimited: false,
        retryable: true,
      })
    ).toBe("reschedule");
  });
});

describe("resolvePublishRetryBackoffMs", () => {
  it("uses 15 minutes for rate limits", () => {
    expect(resolvePublishRetryBackoffMs(1, true)).toBe(RATE_LIMIT_BACKOFF_MS);
  });

  it("uses shorter backoff for early retries", () => {
    expect(resolvePublishRetryBackoffMs(1, false)).toBe(30_000);
    expect(resolvePublishRetryBackoffMs(2, false)).toBe(120_000);
  });
});
