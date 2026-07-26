import { describe, expect, it } from "vitest";
import {
  buildQueueActionUrl,
  buildReviewEmailHtml,
  parseReviewEmailRecipients,
  resolveReviewEmailRecipients,
} from "@/lib/email/sendReviewEmail";
import { DEFAULT_APP_URL } from "@/lib/appBaseUrl";

describe("sendReviewEmail", () => {
  it("builds queue action URLs from APP_URL", () => {
    const previous = process.env.APP_URL;
    process.env.APP_URL = "https://marketpulse.example.com";

    expect(buildQueueActionUrl("queue-123", "approve")).toBe(
      "https://marketpulse.example.com/api/queue/action?id=queue-123&action=approve"
    );
    expect(buildQueueActionUrl("queue-123", "reject")).toBe(
      "https://marketpulse.example.com/api/queue/action?id=queue-123&action=reject"
    );

    process.env.APP_URL = previous;
  });

  it("falls back to the production default app URL when env is unset", () => {
    const previousApp = process.env.APP_URL;
    const previousPublic = process.env.NEXT_PUBLIC_APP_URL;
    const previousVercel = process.env.VERCEL_URL;
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_URL;

    expect(buildQueueActionUrl("queue-123", "approve")).toBe(
      `${DEFAULT_APP_URL}/api/queue/action?id=queue-123&action=approve`
    );

    process.env.APP_URL = previousApp;
    process.env.NEXT_PUBLIC_APP_URL = previousPublic;
    process.env.VERCEL_URL = previousVercel;
  });

  it("parses comma-separated review recipient emails", () => {
    expect(
      parseReviewEmailRecipients(
        "me@example.com, cofounder@example.com"
      )
    ).toEqual(["me@example.com", "cofounder@example.com"]);

    expect(
      parseReviewEmailRecipients("me@example.com;cofounder@example.com")
    ).toEqual(["me@example.com", "cofounder@example.com"]);

    expect(
      parseReviewEmailRecipients(
        "me@example.com, me@example.com, invalid, cofounder@example.com"
      )
    ).toEqual(["me@example.com", "cofounder@example.com"]);
  });

  it("resolves NOTIFICATION_EMAIL when REVIEW_RECIPIENT_EMAILS is unset", () => {
    const keys = [
      "REVIEW_RECIPIENT_EMAILS",
      "NOTIFICATION_EMAIL",
      "REVIEW_EMAIL_TO",
      "EMAIL_REVIEW_TO",
      "X_AGENT_REVIEW_EMAIL_TO",
    ] as const;
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]])
    );

    for (const key of keys) {
      delete process.env[key];
    }
    process.env.NOTIFICATION_EMAIL = "ops@example.com";

    expect(resolveReviewEmailRecipients()).toEqual(["ops@example.com"]);

    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  });

  it("renders trade summary and draft copy in HTML", () => {
    const html = buildReviewEmailHtml({
      id: "queue-abc",
      copyText: "DeepWallet bought yes on China invade Taiwan",
      stakeNotional: 25000,
      evPercent: 2.4,
      marketTitle: "China invade Taiwan",
    });

    expect(html).toContain("China invade Taiwan");
    expect(html).toContain("$25,000");
    expect(html).toContain("+2.4%");
    expect(html).toContain("DeepWallet bought yes on China invade Taiwan");
    expect(html).toContain("action=approve");
    expect(html).toContain("action=reject");
  });
});
