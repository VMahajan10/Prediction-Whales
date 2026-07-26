import { describe, expect, it } from "vitest";
import {
  buildQueueActionUrl,
  buildReviewEmailHtml,
  parseReviewEmailRecipients,
} from "@/lib/email/sendReviewEmail";

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
