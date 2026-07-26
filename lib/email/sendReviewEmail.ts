import { createTransport } from "nodemailer";
import { getAppBaseUrl } from "@/lib/appBaseUrl";

export interface ReviewEmailTrade {
  id: string;
  copyText: string;
  stakeNotional: number;
  /** Live trade EV as display percent (e.g. 2.5 = +2.5%). */
  evPercent: number | null;
  marketTitle: string;
}

export interface SendReviewEmailResult {
  sent: boolean;
  skipped?: boolean;
  error?: string;
}

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

export function buildReviewEmailHtml(trade: ReviewEmailTrade): string {
  const approveUrl = buildQueueActionUrl(trade.id, "approve");
  const rejectUrl = buildQueueActionUrl(trade.id, "reject");
  const market = escapeHtml(trade.marketTitle);
  const copyText = escapeHtml(trade.copyText);
  const stake = escapeHtml(formatStakeUsd(trade.stakeNotional));
  const ev = escapeHtml(formatEvLabel(trade.evPercent));

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
                    <p style="margin:0;font-size:14px;"><strong>EV:</strong> ${ev}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 20px;">
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">Drafted X post</p>
              <div style="padding:16px;background:#0b1220;color:#e8eef8;border-radius:8px;font-size:15px;line-height:1.5;white-space:pre-wrap;">${copyText}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px;">
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
    process.env.REVIEW_EMAIL_TO?.trim() ||
    process.env.EMAIL_REVIEW_TO?.trim() ||
    process.env.X_AGENT_REVIEW_EMAIL_TO?.trim();

  return single ? [single.toLowerCase()] : [];
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

/**
 * Send a human-review email for a queued X post draft.
 * Skips quietly when SMTP or recipient env vars are unset.
 */
export async function sendReviewEmail(
  trade: ReviewEmailTrade
): Promise<SendReviewEmailResult> {
  const recipients = getReviewEmailRecipients();
  if (recipients.length === 0) {
    return {
      sent: false,
      skipped: true,
      error: "REVIEW_RECIPIENT_EMAILS is not configured",
    };
  }

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

  const subject = `Review: ${trade.marketTitle} (${formatStakeUsd(trade.stakeNotional)})`;
  const html = buildReviewEmailHtml(trade);
  const text = [
    "MarketPulse — X Post Review",
    "",
    `Market: ${trade.marketTitle}`,
    `Stake: ${formatStakeUsd(trade.stakeNotional)}`,
    `EV: ${formatEvLabel(trade.evPercent)}`,
    "",
    "Drafted X post:",
    trade.copyText,
    "",
    `Approve: ${buildQueueActionUrl(trade.id, "approve")}`,
    `Reject: ${buildQueueActionUrl(trade.id, "reject")}`,
  ].join("\n");

  await transporter.sendMail({
    from,
    to: recipients,
    subject,
    text,
    html,
  });

  return { sent: true };
}
