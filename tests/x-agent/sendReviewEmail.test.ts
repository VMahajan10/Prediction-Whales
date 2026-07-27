import { describe, expect, it } from "vitest";
import {
  buildQueueActionUrl,
  buildReviewEmailHtml,
  buildReviewPageUrl,
  buildSmsGatewayAlertText,
  DEFAULT_REVIEW_NOTIFICATION_EMAIL,
  isTwilioSmsConfigured,
  parseReviewEmailRecipients,
  resolveReviewEmailRecipients,
} from "@/lib/email/sendReviewEmail";
import { DEFAULT_APP_URL } from "@/lib/appBaseUrl";

describe("sendReviewEmail", () => {
  it("builds queue action URLs from APP_URL", () => {
    const previousRender = process.env.RENDER_EXTERNAL_URL;
    const previous = process.env.APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    process.env.APP_URL = "https://marketpulse.example.com";

    expect(buildQueueActionUrl("queue-123", "approve")).toBe(
      "https://marketpulse.example.com/api/queue/action?id=queue-123&action=approve"
    );
    expect(buildQueueActionUrl("queue-123", "reject")).toBe(
      "https://marketpulse.example.com/api/queue/action?id=queue-123&action=reject"
    );

    process.env.RENDER_EXTERNAL_URL = previousRender;
    process.env.APP_URL = previous;
  });

  it("prefers RENDER_EXTERNAL_URL over APP_URL for queue action links", () => {
    const previousRender = process.env.RENDER_EXTERNAL_URL;
    const previousApp = process.env.APP_URL;
    process.env.RENDER_EXTERNAL_URL = "https://mvp-2324.onrender.com";
    process.env.APP_URL = "https://wrong-host.example.com";

    expect(buildQueueActionUrl("real-queue-uuid", "approve")).toBe(
      "https://mvp-2324.onrender.com/api/queue/action?id=real-queue-uuid&action=approve"
    );

    process.env.RENDER_EXTERNAL_URL = previousRender;
    process.env.APP_URL = previousApp;
  });

  it("falls back to the production default app URL when env is unset", () => {
    const previousRender = process.env.RENDER_EXTERNAL_URL;
    const previousApp = process.env.APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    delete process.env.APP_URL;

    expect(buildQueueActionUrl("queue-123", "approve")).toBe(
      `${DEFAULT_APP_URL}/api/queue/action?id=queue-123&action=approve`
    );

    process.env.RENDER_EXTERNAL_URL = previousRender;
    process.env.APP_URL = previousApp;
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

  it("falls back to the default notification email when env is unset", () => {
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

    expect(resolveReviewEmailRecipients()).toEqual([
      DEFAULT_REVIEW_NOTIFICATION_EMAIL,
    ]);

    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  });

  it("skips Twilio SMS dispatch when env vars are unset", () => {
    const keys = [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_PHONE_NUMBER",
      "ALERT_SMS_TO",
    ] as const;
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]])
    );

    for (const key of keys) {
      delete process.env[key];
    }

    expect(isTwilioSmsConfigured()).toBe(false);

    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  });

  it("detects Twilio SMS when all env vars are set", () => {
    const keys = [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_PHONE_NUMBER",
      "ALERT_SMS_TO",
    ] as const;
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]])
    );

    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_PHONE_NUMBER = "+15551234567";
    process.env.ALERT_SMS_TO = "+17036404542";

    expect(isTwilioSmsConfigured()).toBe(true);

    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  });

  it("builds direct review page URLs from NEXT_PUBLIC_APP_URL", () => {
    const previousPublic = process.env.NEXT_PUBLIC_APP_URL;
    const previousReviewBase = process.env.REVIEW_PUBLIC_BASE_URL;
    const previousRender = process.env.RENDER_EXTERNAL_URL;
    const previousApp = process.env.APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    delete process.env.APP_URL;
    delete process.env.REVIEW_PUBLIC_BASE_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://marketpulse.example.com";

    expect(buildReviewPageUrl("queue-edit-1")).toBe(
      "https://marketpulse.example.com/review/queue-edit-1"
    );

    process.env.NEXT_PUBLIC_APP_URL = previousPublic;
    process.env.REVIEW_PUBLIC_BASE_URL = previousReviewBase;
    process.env.RENDER_EXTERNAL_URL = previousRender;
    process.env.APP_URL = previousApp;
  });

  it("falls back to production Render URL for review links", () => {
    const previousPublic = process.env.NEXT_PUBLIC_APP_URL;
    const previousReviewBase = process.env.REVIEW_PUBLIC_BASE_URL;
    const previousRender = process.env.RENDER_EXTERNAL_URL;
    const previousApp = process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.REVIEW_PUBLIC_BASE_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    delete process.env.APP_URL;

    expect(buildReviewPageUrl("queue-prod-1")).toBe(
      `${DEFAULT_APP_URL}/review/queue-prod-1`
    );

    process.env.NEXT_PUBLIC_APP_URL = previousPublic;
    process.env.REVIEW_PUBLIC_BASE_URL = previousReviewBase;
    process.env.RENDER_EXTERNAL_URL = previousRender;
    process.env.APP_URL = previousApp;
  });

  it("builds a short SMS gateway alert body with review page link", () => {
    const previousPublic = process.env.NEXT_PUBLIC_APP_URL;
    const previousReviewBase = process.env.REVIEW_PUBLIC_BASE_URL;
    const previousRender = process.env.RENDER_EXTERNAL_URL;
    const previousApp = process.env.APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    delete process.env.APP_URL;
    delete process.env.REVIEW_PUBLIC_BASE_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://marketpulse.example.com";

    const text = buildSmsGatewayAlertText({
      id: "queue-sms-1",
      copyText: "draft",
      stakeNotional: 25_000,
      evPercent: 4.2,
      marketTitle: "Fed cut rates in September",
    });

    expect(text).toContain("Stake: $25,000");
    expect(text).toContain("Market: Fed cut rates in September");
    expect(text).toContain("EV: +4.2%");
    expect(text).toContain(
      "https://marketpulse.example.com/review/queue-sms-1"
    );

    process.env.NEXT_PUBLIC_APP_URL = previousPublic;
    process.env.REVIEW_PUBLIC_BASE_URL = previousReviewBase;
    process.env.RENDER_EXTERNAL_URL = previousRender;
    process.env.APP_URL = previousApp;
  });

  it("renders trade summary and draft copy in HTML", () => {
    const html = buildReviewEmailHtml({
      id: "queue-abc",
      copyText: "DeepWallet bought yes on China invade Taiwan",
      stakeNotional: 25000,
      evPercent: 2.4,
      marketTitle: "China invade Taiwan",
      queuedAt: new Date("2026-03-10T17:00:00.000Z"),
    });

    expect(html).toContain("China invade Taiwan");
    expect(html).toContain("$25,000");
    expect(html).toContain("+2.4%");
    expect(html).toContain("Queued:");
    expect(html).toContain("DeepWallet bought yes on China invade Taiwan");
    expect(html).toContain("Review &amp; Edit");
    expect(html).toContain("/review/queue-abc");
    expect(html).toContain("action=approve");
    expect(html).toContain("action=reject");
  });
});
