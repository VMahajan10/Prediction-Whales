import { describe, expect, it } from "vitest";
import { isPublicReviewPath } from "@/lib/publicRoutes";

describe("publicRoutes", () => {
  it("marks /review/[id] as public", () => {
    expect(isPublicReviewPath("/review/abc-123")).toBe(true);
    expect(isPublicReviewPath("/login")).toBe(false);
  });
});
