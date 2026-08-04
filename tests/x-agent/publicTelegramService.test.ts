import { afterEach, describe, expect, it } from "vitest";
import {
  escapeTelegramHtml,
  isPublicTelegramConfigured,
  sendPublicTelegramPost,
} from "@/lib/services/publicTelegramService";

describe("publicTelegramService", () => {
  const envKeys = ["PUBLIC_TELEGRAM_BOT_TOKEN", "PUBLIC_TELEGRAM_CHAT_ID"];

  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  it("detects public Telegram when bot token and chat id are set", () => {
    process.env.PUBLIC_TELEGRAM_BOT_TOKEN = "123456:ABC";
    process.env.PUBLIC_TELEGRAM_CHAT_ID = "@marketpulse_public";
    expect(isPublicTelegramConfigured()).toBe(true);
  });

  it("skips public Telegram when env vars are unset", () => {
    expect(isPublicTelegramConfigured()).toBe(false);
  });

  it("escapes HTML characters in post copy", () => {
    expect(escapeTelegramHtml("Stake < $500 & EV > 3%")).toBe(
      "Stake &lt; $500 &amp; EV &gt; 3%"
    );
  });

  it("sendPublicTelegramPost skips when not configured", async () => {
    const result = await sendPublicTelegramPost("Hello whale world");
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe(true);
  });

  it("sendPublicTelegramPost rejects empty copy", async () => {
    process.env.PUBLIC_TELEGRAM_BOT_TOKEN = "123456:ABC";
    process.env.PUBLIC_TELEGRAM_CHAT_ID = "@marketpulse_public";

    const result = await sendPublicTelegramPost("   ");
    expect(result.sent).toBe(false);
    expect(result.skipped).toBeUndefined();
    expect(result.error).toBe("Post copy is empty");
  });
});
