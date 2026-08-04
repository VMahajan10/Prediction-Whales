import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

export interface PublicTelegramPostResult {
  sent: boolean;
  skipped?: boolean;
  messageId?: string;
  error?: string;
}

export interface PublicTelegramPostMedia {
  /** HTTPS URL — used when receipt is already hosted */
  url?: string;
  /** In-memory receipt PNG from generateWhaleReceiptPng */
  buffer?: Buffer;
  filename?: string;
}

export function isPublicTelegramConfigured(): boolean {
  return Boolean(
    process.env.PUBLIC_TELEGRAM_BOT_TOKEN?.trim() &&
      process.env.PUBLIC_TELEGRAM_CHAT_ID?.trim()
  );
}

/** Escape dynamic text for Telegram HTML parse_mode. */
export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function parseTelegramResponse(
  response: Response
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: { message_id?: number };
    description?: string;
  } | null;

  if (!response.ok || !body?.ok || body.result?.message_id == null) {
    const detail =
      body?.description ??
      (response.ok ? "missing message_id in Telegram response" : "");
    return {
      ok: false,
      error: `HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`,
    };
  }

  return { ok: true, messageId: String(body.result.message_id) };
}

/**
 * Broadcast a scheduled post to the public Telegram channel.
 * Uses PUBLIC_TELEGRAM_BOT_TOKEN / PUBLIC_TELEGRAM_CHAT_ID (separate from draft alerts).
 */
export async function sendPublicTelegramPost(
  content: string,
  media?: PublicTelegramPostMedia
): Promise<PublicTelegramPostResult> {
  const botToken = process.env.PUBLIC_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.PUBLIC_TELEGRAM_CHAT_ID?.trim();

  if (!botToken || !chatId) {
    return {
      sent: false,
      skipped: true,
      error:
        "PUBLIC_TELEGRAM_BOT_TOKEN or PUBLIC_TELEGRAM_CHAT_ID is not configured",
    };
  }

  const text = escapeTelegramHtml(content.trim());
  if (!text) {
    return { sent: false, error: "Post copy is empty" };
  }

  const base = `https://api.telegram.org/bot${botToken}`;

  try {
    if (media?.buffer) {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", text);
      form.append("parse_mode", "HTML");
      form.append(
        "photo",
        new Blob([new Uint8Array(media.buffer)], { type: "image/png" }),
        media.filename ?? "whale-receipt.png"
      );

      const response = await fetchWithTimeout(`${base}/sendPhoto`, {
        method: "POST",
        body: form,
        timeoutMs: 20_000,
      });
      const parsed = await parseTelegramResponse(response);
      if (!parsed.ok) throw new Error(parsed.error);
      console.log(
        "[Public Telegram] Photo post sent messageId=",
        parsed.messageId
      );
      return { sent: true, messageId: parsed.messageId };
    }

    if (media?.url?.trim()) {
      const response = await fetchWithTimeout(`${base}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          photo: media.url.trim(),
          caption: text,
          parse_mode: "HTML",
        }),
        timeoutMs: 20_000,
      });
      const parsed = await parseTelegramResponse(response);
      if (!parsed.ok) throw new Error(parsed.error);
      console.log(
        "[Public Telegram] Photo URL post sent messageId=",
        parsed.messageId
      );
      return { sent: true, messageId: parsed.messageId };
    }

    const response = await fetchWithTimeout(`${base}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
      timeoutMs: 12_000,
    });
    const parsed = await parseTelegramResponse(response);
    if (!parsed.ok) throw new Error(parsed.error);
    console.log(
      "[Public Telegram] Text post sent messageId=",
      parsed.messageId
    );
    return { sent: true, messageId: parsed.messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Public Telegram] Broadcast failed:", message);
    return { sent: false, error: message };
  }
}
