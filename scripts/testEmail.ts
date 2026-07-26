/**
 * Send a one-off review email using mock queue data (SMTP / Resend).
 *
 * Usage:
 *   npm run test:email
 *   npx tsx --tsconfig tsconfig.json scripts/testEmail.ts
 *
 * Required env (from .env / .env.local):
 *   APP_URL, REVIEW_RECIPIENT_EMAILS, EMAIL_FROM, SMTP_HOST, SMTP_USER, SMTP_PASS
 */
import { loadEnvFiles } from "./loadEnv";
import { sendReviewEmail } from "../lib/email/sendReviewEmail";

loadEnvFiles();

const MOCK_TRADE = {
  id: "test-trade-123",
  copyText:
    "🚨 WHALE ALERT: 50,000 USDC bet on Yes for 'Will Fed Cut Rates in September?' EV: +4.2%, Stake: $50,000.",
  marketTitle: "Will Fed Cut Rates in September?",
  stakeNotional: 50_000,
  evPercent: 4.2,
} as const;

async function main(): Promise<void> {
  console.log("[testEmail] Sending mock review email…");
  console.log("[testEmail] Trade:", MOCK_TRADE);

  const result = await sendReviewEmail({
    id: MOCK_TRADE.id,
    copyText: MOCK_TRADE.copyText,
    marketTitle: MOCK_TRADE.marketTitle,
    stakeNotional: MOCK_TRADE.stakeNotional,
    evPercent: MOCK_TRADE.evPercent,
  });

  if (result.sent) {
    console.log("[testEmail] ✓ Email sent successfully");
    return;
  }

  if (result.skipped) {
    console.warn("[testEmail] Skipped:", result.error ?? "unknown reason");
    process.exit(1);
  }

  console.error("[testEmail] Failed:", result.error ?? "unknown error");
  process.exit(1);
}

main().catch((error) => {
  console.error("[testEmail] Unexpected error:", error);
  process.exit(1);
});
