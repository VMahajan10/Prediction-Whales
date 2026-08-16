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
  /** Rendered V1–V8 draft from the Templates.md engine. */
  draftCopy?: string;
}

export function isTelegramConfigured(): boolean {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN?.trim() &&
      process.env.TELEGRAM_CHAT_ID?.trim()
  );
}

/** Escape dynamic text for Telegram HTML parse_mode. */
function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatStakeUsd(stakeNotional: number): string {
  return `$${Math.round(stakeNotional).toLocaleString("en-US")}`;
}

function formatEvLabel(evPercent: number | null): string {
  if (evPercent == null || !Number.isFinite(evPercent)) return "N/A";
  const sign = evPercent >= 0 ? "+" : "";
  return `${sign}${evPercent.toFixed(1)}%`;
}

/** HTML body for a high-conviction whale trade review alert. */
export function buildTelegramTradeAlertMessage(
  input: TradeTelegramAlertInput
): string {
  const reviewUrl = escapeTelegramHtml(buildReviewPageUrl(input.queueId));
  const whale = escapeTelegramHtml(input.whaleName.trim() || "Unknown");
  const market = escapeTelegramHtml(input.marketTitle.trim() || "Unknown");
  const stake = escapeTelegramHtml(formatStakeUsd(input.stakeNotional));
  const ev = escapeTelegramHtml(formatEvLabel(input.evPercent));
  const draft = escapeTelegramHtml(
    input.draftCopy?.trim() || "Draft ready for review"
  );

  return [
    draft,
    "",
    `<b>Whale:</b> ${whale}`,
    `<b>Stake:</b> ${stake}`,
    `<b>Market:</b> ${market}`,
    `<b>EV:</b> ${ev}`,
    `<b>Link:</b> ${reviewUrl}`,
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
        parse_mode: "HTML",
      }),
      timeoutMs: 12_000,
    });

    if (response.status === 429) {
      console.warn("[Telegram Alert] Rate limited (429)");
      return {
        sent: false,
        skipped: true,
        error: "Telegram rate limit reached (429)",
      };
    }

    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;

    if (!response.ok || !body?.ok) {
      const detail = body?.description ?? "";
      const message = `HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`;

      if (/too many requests|retry after/i.test(detail)) {
        console.warn("[Telegram Alert] Rate limited:", message);
        return {
          sent: false,
          skipped: true,
          error: "Telegram rate limit reached",
        };
      }

      throw new Error(message);
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
