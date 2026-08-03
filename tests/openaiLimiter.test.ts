import { describe, expect, it, vi } from "vitest";
import { withOpenAiLimiter } from "@/lib/ai/openaiLimiter";

describe("withOpenAiLimiter", () => {
  it("runs the wrapped function and returns its value", async () => {
    const value = await withOpenAiLimiter(async () => 42);
    expect(value).toBe(42);
  });

  it("retries on rate-limit errors", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("Rate limit reached for gpt-4o-mini");
      }
      return "ok";
    });

    const value = await withOpenAiLimiter(fn);
    expect(value).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
