import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_APP_URL } from "@/lib/appBaseUrl";
import {
  buildTelegramTradeAlertMessage,
  isTelegramConfigured,
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

  it("builds a Markdown trade alert with whale, stake, market, EV, and link", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://marketpulse.example.com";

    const message = buildTelegramTradeAlertMessage({
      whaleName: "DeepWallet",
      stakeNotional: 25_000,
      marketTitle: "Fed cut rates in September",
      evPercent: 4.2,
      queueId: "queue-tg-1",
    });

    expect(message).toContain("*Whale:* DeepWallet");
    expect(message).toContain("*Stake:* $25,000");
    expect(message).toContain("*Market:* Fed cut rates in September");
    expect(message).toContain("*EV:* +4.2%");
    expect(message).toContain(
      "https://marketpulse.example.com/review/queue-tg-1"
    );
  });

  it("escapes Markdown characters in whale and market names", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://marketpulse.example.com";

    const message = buildTelegramTradeAlertMessage({
      whaleName: "Whale_*One",
      stakeNotional: 10_000,
      marketTitle: "Will [Team A] win?",
      evPercent: 2.5,
      queueId: "queue-tg-2",
    });

    expect(message).toContain("Whale\\_\\*One");
    expect(message).toContain("Will \\[Team A\\] win?");
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
});
