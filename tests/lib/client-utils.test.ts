import { describe, expect, it } from "vitest";
import { formatToEST, getTimeAgo } from "@/lib/client-utils";

describe("formatToEST", () => {
  it("formats a Date in America/New_York with a short zone label", () => {
    const formatted = formatToEST(new Date("2026-01-15T18:30:00.000Z"));
    expect(formatted).toMatch(/Jan/);
    expect(formatted).toMatch(/2026/);
    expect(formatted).toMatch(/E[DS]T/);
  });

  it("accepts unix seconds", () => {
    const formatted = formatToEST(1_700_000_000);
    expect(formatted).not.toBe("Invalid date");
  });

  it("accepts ISO strings", () => {
    const formatted = formatToEST("2026-03-10T12:00:00.000Z");
    expect(formatted).not.toBe("Invalid date");
  });
});

describe("getTimeAgo", () => {
  it("returns a relative label for recent timestamps", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(getTimeAgo(now - 30)).toMatch(/seconds ago/);
  });
});
