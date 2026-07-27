import { describe, expect, it } from "vitest";
import {
  buildLoginUrlWithRedirect,
  buildReviewEditLoginUrl,
  sanitizeRedirectPath,
} from "@/lib/authRedirect";

describe("authRedirect", () => {
  it("sanitizes redirect paths to same-origin relative URLs", () => {
    expect(sanitizeRedirectPath("/review/abc")).toBe("/review/abc");
    expect(sanitizeRedirectPath("https://evil.com")).toBe("/");
    expect(sanitizeRedirectPath("//evil.com")).toBe("/");
    expect(sanitizeRedirectPath(null)).toBe("/");
  });

  it("builds login URLs with redirectTo query params", () => {
    const previousPublic = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    delete process.env.APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://marketpulse.example.com";

    expect(buildLoginUrlWithRedirect("/review/queue-edit-1")).toBe(
      "https://marketpulse.example.com/login?redirectTo=%2Freview%2Fqueue-edit-1"
    );

    expect(buildReviewEditLoginUrl("queue-edit-1")).toBe(
      "https://marketpulse.example.com/login?redirectTo=%2Freview%2Fqueue-edit-1"
    );

    process.env.NEXT_PUBLIC_APP_URL = previousPublic;
  });
});
