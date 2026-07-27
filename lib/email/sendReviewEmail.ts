import { createTransport } from "nodemailer";
import { DEFAULT_APP_URL, getAppBaseUrl } from "@/lib/appBaseUrl";
import { formatToEST } from "@/lib/client-utils";
import {
  getTwilioAlertSmsTo,
  isTwilioSmsConfigured,
  sendTwilioSmsAlert,
} from "@/lib/sms/twilioAlert";

export {
  getTwilioAlertSmsTo,
  isTwilioSmsConfigured,
} from "@/lib/sms/twilioAlert";

export interface ReviewEmailTrade {
  id: string;
  copyText: string;
  renderedDraft?: string;
  templateFamily?: string;
  variantId?: string;
  stakeNotional: number;
  /** Live trade EV as display percent (e.g. 2.5 = +2.5%). */
  evPercent: number | null;
  marketTitle: string;
  /** When the queue row was created (shown in EST/EDT). */
  queuedAt?: Date | string | number;
}

export interface SendReviewEmailResult {
  sent: boolean;
  skipped?: boolean;
  error?: string;
  messageSid?: string;
}

export interface SendEmailNotificationOptions {
  /** Override recipient (e.g. carrier SMS gateway address). */
  to?: string;
  subject?: string;
  /** Plain-text body; skips HTML review template when set. */
  text?: string;
  plainTextOnly?: boolean;
}

/** Used when NOTIFICATION_EMAIL / REVIEW_RECIPIENT_EMAILS are unset. */
export const DEFAULT_REVIEW_NOTIFICATION_EMAIL = "reviews@marketpulse.app";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatStakeUsd(stakeNotional: number): string {
  return `$${Math.round(stakeNotional).toLocaleString("en-US")}`;
}

function formatEvLabel(evPercent: number | null): string {
  if (evPercent == null || !Number.isFinite(evPercent)) return "N/A";
  const sign = evPercent >= 0 ? "+" : "";
  return `${sign}${evPercent.toFixed(1)}%`;
}

export function buildQueueActionUrl(
  queueId: string,
  action: "approve" | "reject"
): string {
  const base = getAppBaseUrl();
  const params = new URLSearchParams({
    id: queueId,
    action,
  });
  return `${base}/api/queue/action?${params.toString()}`;
}

function resolveReviewPublicBaseUrl(): string {
  const candidates = [
    process.env.REVIEW_PUBLIC_BASE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    DEFAULT_APP_URL,
  ];

  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (trimmed && trimmed !== "undefined") {
      return trimmed.replace(/\/$/, "");
    }
  }

  return DEFAULT_APP_URL;
}

/** Direct public link to the review editor (no login required). */
export function buildReviewPageUrl(queueId: string): string {
  return `${resolveReviewPublicBaseUrl()}/review/${encodeURIComponent(queueId)}`;
}

export function buildReviewEmailHtml(trade: ReviewEmailTrade): string {
  const approveUrl = buildQueueActionUrl(trade.id, "approve");
  const rejectUrl = buildQueueActionUrl(trade.id, "reject");
  const reviewUrl = buildReviewPageUrl(trade.id);
  const market = escapeHtml(trade.marketTitle);
  const draft = escapeHtml(trade.renderedDraft ?? trade.copyText);
  const templateMeta = escapeHtml(
    [trade.templateFamily, trade.variantId].filter(Boolean).join(" · ") ||
      "Template pending"
  );
  const stake = escapeHtml(formatStakeUsd(trade.stakeNotional));
  const ev = escapeHtml(formatEvLabel(trade.evPercent));
  const queuedAt =
    trade.queuedAt != null
      ? escapeHtml(formatToEST(trade.queuedAt))
      : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MarketPulse — X Post Review</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
          <tr>
            <td style="padding:24px 28px 8px;">
              <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">MarketPulse Review Queue</p>
              <h1 style="margin:0;font-size:22px;line-height:1.3;">New whale trade draft</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 20px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
                <tr>
                  <td style="padding:16px;">
                    <p style="margin:0 0 10px;font-size:14px;"><strong>Market:</strong> ${market}</p>
                    <p style="margin:0 0 10px;font-size:14px;"><strong>Stake:</strong> ${stake}</p>
                    <p style="margin:0 0 10px;font-size:14px;"><strong>EV:</strong> ${ev}</p>
                    ${queuedAt ? `<p style="margin:0;font-size:14px;"><strong>Queued:</strong> ${queuedAt}</p>` : ""}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 20px;">
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">Tweet draft</p>
              <p style="margin:0 0 12px;font-size:12px;color:#9ca3af;">Template: ${templateMeta}</p>
              <div style="padding:18px;background:#0b1220;color:#e8eef8;border-radius:10px;font-size:16px;line-height:1.55;white-space:pre-wrap;border:1px solid #1f2937;">${draft}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px;">
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin-bottom:16px;">
                <tr>
                  <td>
                    <a href="${reviewUrl}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Review &amp; Edit</a>
                  </td>
                </tr>
              </table>
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="padding-right:12px;">
                    <a href="${approveUrl}" style="display:inline-block;padding:12px 20px;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Approve</a>
                  </td>
                  <td>
                    <a href="${rejectUrl}" style="display:inline-block;padding:12px 20px;background:#dc2626;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Reject</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Parse comma- or semicolon-separated review inboxes. */
export function parseReviewEmailRecipients(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];

  const seen = new Set<string>();
  const recipients: string[] = [];

  for (const part of raw.split(/[,;]/)) {
    const email = part.trim().toLowerCase();
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    recipients.push(email);
  }

  return recipients;
}

function getReviewEmailRecipients(): string[] {
  const fromList = parseReviewEmailRecipients(
    process.env.REVIEW_RECIPIENT_EMAILS
  );
  if (fromList.length > 0) return fromList;

  const single =
    process.env.NOTIFICATION_EMAIL?.trim() ||
    process.env.REVIEW_EMAIL_TO?.trim() ||
    process.env.EMAIL_REVIEW_TO?.trim() ||
    process.env.X_AGENT_REVIEW_EMAIL_TO?.trim() ||
    DEFAULT_REVIEW_NOTIFICATION_EMAIL;

  return [single.toLowerCase()];
}

/** Resolved notification inboxes from env (REVIEW_RECIPIENT_EMAILS, NOTIFICATION_EMAIL, etc.). */
export function resolveReviewEmailRecipients(): string[] {
  return getReviewEmailRecipients();
}

/** Effective notification target for queue logs (never undefined). */
export function getEffectiveNotificationEmailForLog(): string {
  return (
    process.env.NOTIFICATION_EMAIL?.trim() ||
    process.env.REVIEW_RECIPIENT_EMAILS?.trim() ||
    DEFAULT_REVIEW_NOTIFICATION_EMAIL
  );
}

/** Log review-email env at worker startup (after preload-env). */
export function logReviewEmailEnvAtStartup(): void {
  console.log(
    "⚙️ [Env Check] NOTIFICATION_EMAIL =",
    process.env.NOTIFICATION_EMAIL?.trim() || DEFAULT_REVIEW_NOTIFICATION_EMAIL
  );
  console.log(
    "⚙️ [Env Check] REVIEW_RECIPIENT_EMAILS =",
    process.env.REVIEW_RECIPIENT_EMAILS?.trim() ||
      DEFAULT_REVIEW_NOTIFICATION_EMAIL
  );
  console.log(
    "⚙️ [Env Check] TWILIO_ACCOUNT_SID =",
    process.env.TWILIO_ACCOUNT_SID?.trim() ? "(set)" : "(not set)"
  );
  console.log(
    "⚙️ [Env Check] TWILIO_PHONE_NUMBER =",
    process.env.TWILIO_PHONE_NUMBER?.trim() || "(not set)"
  );
  console.log(
    "⚙️ [Env Check] ALERT_SMS_TO =",
    getTwilioAlertSmsTo() || "(not set)"
  );
}

function getEmailFromAddress(): string | null {
  const from =
    process.env.EMAIL_FROM?.trim() ||
    process.env.SMTP_FROM?.trim() ||
    process.env.REVIEW_EMAIL_FROM?.trim();
  return from || null;
}

function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST?.trim());
}

export function buildSmsGatewayAlertText(trade: ReviewEmailTrade): string {
  const reviewUrl = buildReviewPageUrl(trade.id);
  const stake = formatStakeUsd(trade.stakeNotional);
  const ev = formatEvLabel(trade.evPercent);
  return `Stake: ${stake} | Market: ${trade.marketTitle} | EV: ${ev} | Review: ${reviewUrl}`;
}

async function sendMailMessage(params: {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}): Promise<SendReviewEmailResult> {
  const from = getEmailFromAddress();
  if (!from) {
    return {
      sent: false,
      skipped: true,
      error: "EMAIL_FROM is not configured",
    };
  }

  if (!isSmtpConfigured()) {
    return {
      sent: false,
      skipped: true,
      error: "SMTP_HOST is not configured",
    };
  }

  const port = Number(process.env.SMTP_PORT ?? 587);
  const secure =
    process.env.SMTP_SECURE === "1" ||
    process.env.SMTP_SECURE === "true" ||
    port === 465;

  const transporter = createTransport({
    host: process.env.SMTP_HOST!.trim(),
    port: Number.isFinite(port) ? port : 587,
    secure,
    auth:
      process.env.SMTP_USER?.trim() && process.env.SMTP_PASS
        ? {
            user: process.env.SMTP_USER.trim(),
            pass: process.env.SMTP_PASS,
          }
        : undefined,
  });

  try {
    await transporter.sendMail({
      from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      ...(params.html ? { html: params.html } : {}),
    });
  } catch (error) {
    console.error("Email send failed:", error);
    return {
      sent: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { sent: true };
}

/**
 * Send a human-review email for a queued X post draft.
 * Skips quietly when SMTP or recipient env vars are unset.
 */
export async function sendReviewEmail(
  trade: ReviewEmailTrade,
  _options?: SendEmailNotificationOptions
): Promise<SendReviewEmailResult> {
  const recipients = getReviewEmailRecipients();
  if (recipients.length === 0) {
    const error = "No notification recipient configured";
    console.error("❌ Review email misconfigured:", error);
    return {
      sent: false,
      skipped: true,
      error,
    };
  }

  const subject = `Review: ${trade.marketTitle} (${formatStakeUsd(trade.stakeNotional)})`;
  const html = buildReviewEmailHtml(trade);
  const text = [
    "MarketPulse — X Post Review",
    "",
    `Market: ${trade.marketTitle}`,
    `Stake: ${formatStakeUsd(trade.stakeNotional)}`,
    `EV: ${formatEvLabel(trade.evPercent)}`,
    ...(trade.queuedAt != null
      ? [`Queued: ${formatToEST(trade.queuedAt)}`]
      : []),
    "",
    "Drafted X post:",
    trade.renderedDraft ?? trade.copyText,
    "",
    `Review & Edit: ${buildReviewPageUrl(trade.id)}`,
    `Approve: ${buildQueueActionUrl(trade.id, "approve")}`,
    `Reject: ${buildQueueActionUrl(trade.id, "reject")}`,
  ].join("\n");

  return sendMailMessage({
    to: recipients,
    subject,
    text,
    html,
  });
}

/** Queue review email dispatch (alias used after x_post_queue insert). */
export async function sendEmailNotification(
  trade: ReviewEmailTrade,
  options?: SendEmailNotificationOptions
): Promise<SendReviewEmailResult> {
  return sendReviewEmail(trade, options);
}

/** Whale alert SMS via Twilio (TWILIO_* + ALERT_SMS_TO). */
export async function sendSmsGatewayNotification(
  trade: ReviewEmailTrade
): Promise<SendReviewEmailResult> {
  const alertMessage = buildSmsGatewayAlertText(trade);
  const result = await sendTwilioSmsAlert(alertMessage);
  return result;
}
