import { afterEach, describe, expect, it } from "vitest";
import { checkIpRateLimit } from "@/lib/rateLimit/ipRateLimit";

describe("checkIpRateLimit", () => {
  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("allows requests under the limit using in-memory fallback", async () => {
    const key = `test:${Date.now()}:${Math.random()}`;

    for (let i = 0; i < 10; i += 1) {
      const result = await checkIpRateLimit(key, 10, 60);
      expect(result.allowed).toBe(true);
    }

    const blocked = await checkIpRateLimit(key, 10, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });
});
