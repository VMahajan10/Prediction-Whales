import { afterEach, describe, expect, it } from "vitest";
import {
  formatDailyLimitLogMessage,
  getDailyPostLimitStatus,
  getUtcDayStart,
  MAX_DAILY_POSTS_DEFAULT,
  MAX_DAILY_POSTS_HARD_CAP,
  resolveMaxDailyPosts,
} from "@/lib/x-agent/dailyPostLimit";

describe("dailyPostLimit", () => {
  const envKeys = ["MAX_DAILY_POSTS"];

  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  it("defaults MAX_DAILY_POSTS to 5", () => {
    expect(resolveMaxDailyPosts()).toBe(MAX_DAILY_POSTS_DEFAULT);
    expect(MAX_DAILY_POSTS_DEFAULT).toBe(5);
  });

  it("clamps env MAX_DAILY_POSTS to the hard cap of 6", () => {
    process.env.MAX_DAILY_POSTS = "10";
    expect(resolveMaxDailyPosts()).toBe(MAX_DAILY_POSTS_HARD_CAP);

    process.env.MAX_DAILY_POSTS = "6";
    expect(resolveMaxDailyPosts()).toBe(6);

    process.env.MAX_DAILY_POSTS = "3";
    expect(resolveMaxDailyPosts()).toBe(3);
  });

  it("returns UTC midnight for getUtcDayStart", () => {
    const start = getUtcDayStart(new Date("2026-07-28T15:30:00.000Z"));
    expect(start.toISOString()).toBe("2026-07-28T00:00:00.000Z");
  });

  it("formats the daily limit log message", () => {
    expect(formatDailyLimitLogMessage(5, 5)).toBe(
      "[X Publisher] Daily post limit reached (5/5). Skipping further publishes until tomorrow."
    );
  });

  it("detects when the daily limit is reached", async () => {
    const status = await getDailyPostLimitStatus(async () => 5);
    expect(status.limited).toBe(true);
    expect(status.publishedToday).toBe(5);
    expect(status.maxDailyPosts).toBe(5);
  });

  it("allows publishing when below the daily limit", async () => {
    const status = await getDailyPostLimitStatus(async () => 4);
    expect(status.limited).toBe(false);
  });
});
