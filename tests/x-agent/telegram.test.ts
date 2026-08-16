import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_URL } from "@/lib/appBaseUrl";
import {
  buildTelegramTradeAlertMessage,
  isTelegramConfigured,
  sendTelegramAlert,
} from "@/lib/notifications/telegram";

describe("telegram notifications", () => {
  const envKeys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "NEXT_PUBLIC_APP_URL"];

  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  it("detects Telegram when bot token and chat id are set", () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:ABC";
    process.env.TELEGRAM_CHAT_ID = "-1001234567890";
    expect(isTelegramConfigured()).toBe(true);
  });

  it("skips Telegram when env vars are unset", () => {
    expect(isTelegramConfigured()).toBe(false);
  });

  it("builds an HTML trade alert with draft lead-in, whale, stake, market, EV, and link", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://marketpulse.example.com";

    const message = buildTelegramTradeAlertMessage({
      whaleName: "DeepWallet",
      stakeNotional: 25_000,
      marketTitle: "Fed cut rates in September",
      evPercent: 4.2,
      queueId: "queue-tg-1",
      draftCopy:
        "DeepWallet just put $25K on Fed cut at 64¢. Their record: 68% across 1,240 resolved bets.",
    });

    expect(message.startsWith("DeepWallet just put $25K")).toBe(true);
    expect(message).not.toContain("🚨");
    expect(message).not.toContain("WHALE ALERT");
    expect(message).toContain("<b>Whale:</b> DeepWallet");
    expect(message).toContain("<b>Stake:</b> $25,000");
    expect(message).toContain("<b>Market:</b> Fed cut rates in September");
    expect(message).toContain("<b>EV:</b> +4.2%");
    expect(message).toContain(
      "https://marketpulse.example.com/review/queue-tg-1"
    );
  });

  it("escapes HTML characters in whale and market names", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://marketpulse.example.com";

    const message = buildTelegramTradeAlertMessage({
      whaleName: "Whale<One> & Co",
      stakeNotional: 10_000,
      marketTitle: "Will S&P 500 close > 6000?",
      evPercent: 2.5,
      queueId: "queue-tg-2",
    });

    expect(message).toContain("Whale&lt;One&gt; &amp; Co");
    expect(message).toContain("Will S&amp;P 500 close &gt; 6000?");
  });

  it("leaves Markdown metacharacters untouched under HTML parse mode", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://marketpulse_preview.example.com";

    const message = buildTelegramTradeAlertMessage({
      whaleName: "Whale_*One",
      stakeNotional: 10_000,
      marketTitle: "Will [Team A] win?",
      evPercent: 2.5,
      queueId: "queue-tg-3",
    });

    expect(message).toContain("Whale_*One");
    expect(message).toContain("Will [Team A] win?");
    expect(message).toContain(
      "https://marketpulse_preview.example.com/review/queue-tg-3"
    );
  });

  it("falls back to production URL for review links", () => {
    const message = buildTelegramTradeAlertMessage({
      whaleName: "DeepWallet",
      stakeNotional: 15_000,
      marketTitle: "China invade Taiwan",
      evPercent: 3.1,
      queueId: "queue-prod-tg",
    });

    expect(message).toContain(`${DEFAULT_APP_URL}/review/queue-prod-tg`);
  });

  it("returns skipped result on Telegram HTTP 429 without throwing", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:ABC";
    process.env.TELEGRAM_CHAT_ID = "-1001234567890";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Too Many Requests", { status: 429 }))
    );

    const result = await sendTelegramAlert("hello");
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain("429");

    vi.unstubAllGlobals();
  });
});
