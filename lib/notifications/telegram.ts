import { buildReviewPageUrl } from "@/lib/email/sendReviewEmail";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

export interface TelegramAlertResult {
  sent: boolean;
  skipped?: boolean;
  error?: string;
}

export interface TradeTelegramAlertInput {
  whaleName: string;
  stakeNotional: number;
  marketTitle: string;
  evPercent: number | null;
  queueId: string;
}

export function isTelegramConfigured(): boolean {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN?.trim() &&
      process.env.TELEGRAM_CHAT_ID?.trim()
  );
}

function escapeTelegramMarkdown(text: string): string {
  return text.replace(/([_*`[\]])/g, "\\$1");
}

function formatStakeUsd(stakeNotional: number): string {
  return `$${Math.round(stakeNotional).toLocaleString("en-US")}`;
}

function formatEvLabel(evPercent: number | null): string {
  if (evPercent == null || !Number.isFinite(evPercent)) return "N/A";
  const sign = evPercent >= 0 ? "+" : "";
  return `${sign}${evPercent.toFixed(1)}%`;
}

/** Markdown body for a high-conviction whale trade review alert. */
export function buildTelegramTradeAlertMessage(
  input: TradeTelegramAlertInput
): string {
  const reviewUrl = buildReviewPageUrl(input.queueId);
  const whale = escapeTelegramMarkdown(input.whaleName.trim() || "Unknown");
  const market = escapeTelegramMarkdown(input.marketTitle.trim() || "Unknown");
  const stake = formatStakeUsd(input.stakeNotional);
  const ev = escapeTelegramMarkdown(formatEvLabel(input.evPercent));

  return [
    "🐋 *Whale Alert*",
    "",
    `*Whale:* ${whale}`,
    `*Stake:* ${stake}`,
    `*Market:* ${market}`,
    `*EV:* ${ev}`,
    `*Link:* ${reviewUrl}`,
  ].join("\n");
}

/**
 * POST to Telegram Bot API sendMessage.
 * Skips quietly when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset.
 */
export async function sendTelegramAlert(
  message: string
): Promise<TelegramAlertResult> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

  if (!botToken || !chatId) {
    return {
      sent: false,
      skipped: true,
      error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured",
    };
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
      timeoutMs: 12_000,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`
      );
    }

    console.log("[Telegram Alert Sent]");
    return { sent: true };
  } catch (error) {
    console.error("[Telegram Alert Error]", error);
    return {
      sent: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Format and send a whale trade review alert to Telegram. */
export async function sendTradeTelegramAlert(
  input: TradeTelegramAlertInput
): Promise<TelegramAlertResult> {
  const message = buildTelegramTradeAlertMessage(input);
  return sendTelegramAlert(message);
}
