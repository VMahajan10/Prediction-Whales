import { afterEach, describe, expect, it } from "vitest";
import {
  isTwitterCredentialsConfigured,
  resolveTwitterCredentials,
} from "@/lib/twitter/credentials";

const ENV_KEYS = [
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_TOKEN_SECRET",
  "TWITTER_API_KEY",
  "TWITTER_API_SECRET",
  "TWITTER_ACCESS_TOKEN",
  "TWITTER_ACCESS_TOKEN_SECRET",
  "X_ACCESS_SECRET",
  "TWITTER_ACCESS_SECRET",
  "X_CONSUMER_KEY",
  "TWITTER_CONSUMER_KEY",
  "X_CONSUMER_SECRET",
  "TWITTER_CONSUMER_SECRET",
] as const;

describe("resolveTwitterCredentials", () => {
  const snapshot: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (snapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key];
      }
    }
  });

  function clearTwitterEnv(): void {
    for (const key of ENV_KEYS) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
  }

  it("resolves canonical X_* variables", () => {
    clearTwitterEnv();
    process.env.X_API_KEY = "app-key";
    process.env.X_API_SECRET = "app-secret";
    process.env.X_ACCESS_TOKEN = "access-token";
    process.env.X_ACCESS_TOKEN_SECRET = "access-secret";

    const result = resolveTwitterCredentials();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appKey).toBe("app-key");
    expect(result.accessSecret).toBe("access-secret");
    expect(isTwitterCredentialsConfigured()).toBe(true);
  });

  it("falls back to TWITTER_* and X_ACCESS_SECRET aliases", () => {
    clearTwitterEnv();
    process.env.TWITTER_API_KEY = "twitter-app-key";
    process.env.TWITTER_API_SECRET = "twitter-app-secret";
    process.env.TWITTER_ACCESS_TOKEN = "twitter-access-token";
    process.env.X_ACCESS_SECRET = "x-access-secret";

    const result = resolveTwitterCredentials();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appKey).toBe("twitter-app-key");
    expect(result.accessSecret).toBe("x-access-secret");
  });

  it("reports canonical missing keys when incomplete", () => {
    clearTwitterEnv();
    process.env.X_API_KEY = "only-key";

    const result = resolveTwitterCredentials();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual([
      "X_API_SECRET",
      "X_ACCESS_TOKEN",
      "X_ACCESS_TOKEN_SECRET",
    ]);
    expect(isTwitterCredentialsConfigured()).toBe(false);
  });
});
