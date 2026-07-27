import { describe, expect, it } from "vitest";
import { loadReviewPageData } from "@/lib/x-agent/loadReviewPageData";

describe("loadReviewPageData", () => {
  it("returns unavailable when DATABASE_URL is unset", async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    const result = await loadReviewPageData("queue-test-1");

    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.title).toBe("Review unavailable");
    }

    if (previous === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previous;
    }
  });

  it("returns not_found for empty id", async () => {
    const result = await loadReviewPageData("   ");
    expect(result.kind).toBe("not_found");
  });
});
