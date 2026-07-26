/**
 * Seed a mock x_post_queue row, then send a review email whose Approve/Reject
 * links resolve against that row in Postgres.
 *
 * Usage:
 *   npm run test:email
 *   npx tsx --tsconfig tsconfig.json scripts/testEmail.ts
 *
 * Required env (from .env / .env.local):
 *   DATABASE_URL, APP_URL, REVIEW_RECIPIENT_EMAILS, EMAIL_FROM,
 *   SMTP_HOST, SMTP_USER, SMTP_PASS
 */
import { randomUUID } from "node:crypto";
import { loadEnvFiles } from "./loadEnv";
import { sendReviewEmail } from "../lib/email/sendReviewEmail";
import { disconnectPrisma, getPrisma, isPrismaEnabled } from "../lib/prisma";
import {
  ANONYMOUS_WALLET_ADDRESS,
  ANONYMOUS_WHALE_PSEUDONYM,
  ensureWhaleInRegistry,
} from "../lib/x-agent/whaleRegistryDb";

loadEnvFiles();

/** x_post_queue.id — must match the id passed to sendReviewEmail for action links. */
const MOCK_QUEUE_ID = "test-trade-123";

const MOCK_TRADE = {
  id: MOCK_QUEUE_ID,
  copyText:
    "🚨 WHALE ALERT: 50,000 USDC bet on Yes for 'Will Fed Cut Rates in September?' EV: +4.2%, Stake: $50,000.",
  marketTitle: "Will Fed Cut Rates in September?",
  marketSlug: "will-fed-cut-rates-in-september",
  stakeNotional: 50_000,
  evPercent: 4.2,
  side: "buy yes",
  entryCents: 42,
  nowCents: 44,
} as const;

async function ensureMockQueueRow(): Promise<void> {
  if (!isPrismaEnabled()) {
    throw new Error("DATABASE_URL is not set");
  }

  const prisma = getPrisma();
  if (!prisma) {
    throw new Error("Prisma client is not available");
  }

  const whaleRegistry = await ensureWhaleInRegistry(ANONYMOUS_WALLET_ADDRESS, {
    pseudonym: ANONYMOUS_WHALE_PSEUDONYM,
    avgStakeNotional: MOCK_TRADE.stakeNotional,
  });
  if (!whaleRegistry) {
    throw new Error("Failed to ensure anonymous whale_registry row");
  }

  const row = await prisma.xPostQueue.upsert({
    where: { id: MOCK_QUEUE_ID },
    create: {
      id: MOCK_QUEUE_ID,
      walletAddress: ANONYMOUS_WALLET_ADDRESS,
      tradeId: `test-email-${MOCK_QUEUE_ID}`,
      templateFamily: "test",
      copyText: MOCK_TRADE.copyText,
      marketSlug: MOCK_TRADE.marketSlug,
      side: MOCK_TRADE.side,
      entryCents: MOCK_TRADE.entryCents,
      nowCents: MOCK_TRADE.nowCents,
      stakeNotional: MOCK_TRADE.stakeNotional,
      status: "PENDING_REVIEW",
      reviewToken: randomUUID(),
    },
    update: {
      copyText: MOCK_TRADE.copyText,
      marketSlug: MOCK_TRADE.marketSlug,
      side: MOCK_TRADE.side,
      entryCents: MOCK_TRADE.entryCents,
      nowCents: MOCK_TRADE.nowCents,
      stakeNotional: MOCK_TRADE.stakeNotional,
      status: "PENDING_REVIEW",
      scheduledFor: null,
      dispatchedAt: null,
    },
  });

  console.log(
    `[testEmail] ✓ x_post_queue row ready id=${row.id} tradeId=${row.tradeId} status=${row.status}`
  );
}

async function main(): Promise<void> {
  console.log("[testEmail] Seeding mock queue row…");
  await ensureMockQueueRow();

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
    console.log(
      `[testEmail] Approve link targets queue id=${MOCK_QUEUE_ID} (reset to PENDING_REVIEW on each run)`
    );
    return;
  }

  if (result.skipped) {
    console.warn("[testEmail] Skipped:", result.error ?? "unknown reason");
    process.exit(1);
  }

  console.error("[testEmail] Failed:", result.error ?? "unknown error");
  process.exit(1);
}

main()
  .catch((error) => {
    console.error("[testEmail] Unexpected error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectPrisma();
  });
