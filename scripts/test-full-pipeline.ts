/**
 * End-to-end dry run: gate matrix → template engine → x_post_queue → review email.
 *
 * Usage:
 *   npm run test:pipeline
 *   ts-node --transpile-only --project tsconfig.scripts.json -r tsconfig-paths/register scripts/test-full-pipeline.ts
 *
 * Required env:
 *   DATABASE_URL, REVIEW_RECIPIENT_EMAILS, EMAIL_FROM, SMTP_HOST, SMTP_USER, SMTP_PASS
 * Optional:
 *   APP_URL (defaults to https://mvp-2324.onrender.com for action links in this script)
 */
import { randomUUID } from "node:crypto";
import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  buildQueueActionUrl,
  sendReviewEmail,
} from "@/lib/email/sendReviewEmail";
import { disconnectPrisma, getPrisma, isPrismaEnabled } from "@/lib/prisma";
import { selectAndRenderPostTemplate } from "@/lib/templates/postTemplates";
import { fetchLastTemplateFamily } from "@/lib/templates/queueHelpers";
import {
  evaluateTradeEligibility,
  MIN_AVG_EV,
  MIN_RESOLVED_BETS,
  type TradePayload,
} from "@/lib/x-agent/gates";
import { ensureWhaleInRegistry } from "@/lib/x-agent/whaleRegistryDb";
import { loadEnvFiles } from "./loadEnv";

loadEnvFiles();

const DEFAULT_TEST_APP_URL = "https://mvp-2324.onrender.com";

const MOCK = {
  tradeEvPercent: 5.2,
  stakeNotional: 2_500,
  entryCents: 32,
  nowCents: 32,
  winRate: 0.68,
  resolvedBetsCount: 620,
  avgEv: 0.04,
  avgStakeNotional: 8_000,
  postedCount30d: 1,
  whalePseudonym: "PipelineTestWhale",
  walletAddress: "0x1111111111111111111111111111111111111111",
  marketTitle: "Will the Fed cut rates in September?",
  marketSlug: "will-fed-cut-rates-in-september",
  marketPlain: "Fed cut rates in September",
  side: "buy yes",
} as const;

function makeWhaleRegistry(): WhaleRegistry {
  const now = new Date();
  return {
    walletAddress: MOCK.walletAddress,
    pseudonym: MOCK.whalePseudonym,
    resolvedBetsCount: MOCK.resolvedBetsCount,
    avgEv: MOCK.avgEv,
    winRate: MOCK.winRate,
    avgStakeNotional: MOCK.avgStakeNotional,
    postedCount30d: MOCK.postedCount30d,
    createdAt: now,
    updatedAt: now,
  };
}

function makeTradePayload(tradeId: string): TradePayload {
  return {
    source: "polymarket",
    tradeId,
    walletAddress: MOCK.walletAddress,
    stakeNotional: MOCK.stakeNotional,
    timestamp: Math.floor(Date.now() / 1000),
    entryCents: MOCK.entryCents,
    nowCents: MOCK.nowCents,
    title: MOCK.marketTitle,
    outcome: "Yes",
    side: "BUY",
    marketSlug: MOCK.marketSlug,
    slug: MOCK.marketSlug,
    eventSlug: null,
  };
}

async function ensureVariantIdColumn(
  prisma: NonNullable<ReturnType<typeof getPrisma>>
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "variant_id" text`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "ev_gloss" text`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "x_media_id" text`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "x_post_queue" ADD COLUMN IF NOT EXISTS "receipt_media_url" text`
  );
}

async function main(): Promise<void> {
  if (!process.env.APP_URL?.trim()) {
    process.env.APP_URL = DEFAULT_TEST_APP_URL;
  }

  console.log("=== [test:pipeline] Step 1 — Mock trade payload ===");
  console.log(
    JSON.stringify(
      {
        evPercent: MOCK.tradeEvPercent,
        stakeUsd: MOCK.stakeNotional,
        entryCents: MOCK.entryCents,
        nowCents: MOCK.nowCents,
        winRate: MOCK.winRate,
        resolvedBets: MOCK.resolvedBetsCount,
        wallet: MOCK.walletAddress,
        market: MOCK.marketTitle,
      },
      null,
      2
    )
  );

  const whale = makeWhaleRegistry();
  if (whale.resolvedBetsCount < MIN_RESOLVED_BETS) {
    throw new Error(`Mock whale resolved bets below floor (${MIN_RESOLVED_BETS})`);
  }
  if (whale.avgEv < MIN_AVG_EV) {
    throw new Error(`Mock whale avg EV below floor (${MIN_AVG_EV})`);
  }

  const tradeId = `pipeline-test-${Date.now()}`;
  const payload = makeTradePayload(tradeId);

  console.log("\n=== [test:pipeline] Step 2 — Gate matrix ===");
  const eligibility = await evaluateTradeEligibility(payload, whale, Date.now(), {
    tradeEvPercent: MOCK.tradeEvPercent,
  });

  console.log("Gate matrix:", {
    passesAll: eligibility.matrix.passesAll,
    passesEv: eligibility.matrix.passesEv,
    passesStake: eligibility.matrix.passesStake,
    passesCredibility: eligibility.matrix.passesCredibility,
    passesAlignment: eligibility.matrix.passesAlignment,
    passesFreshness: eligibility.matrix.passesFreshness,
    passesSource: eligibility.matrix.passesSource,
    reason: eligibility.reason ?? null,
  });

  if (!eligibility.eligible || !eligibility.translation) {
    throw new Error(
      `Trade failed gates: ${eligibility.reason ?? "unknown reason"}`
    );
  }
  console.log("[test:pipeline] ✓ All gates passed");

  console.log("\n=== [test:pipeline] Step 3 — Template selector ===");
  const lastTemplateFamily = isPrismaEnabled()
    ? await fetchLastTemplateFamily(getPrisma()!)
    : undefined;

  const template = selectAndRenderPostTemplate(
    {
      whale: whale.pseudonym,
      side: eligibility.translation.side,
      entry: payload.entryCents,
      now: payload.nowCents,
      avg_ev: whale.avgEv,
      marketPlain: eligibility.translation.marketPlain,
      stakeNotional: payload.stakeNotional,
      avgStakeNotional: whale.avgStakeNotional,
      postedCount30d: whale.postedCount30d,
      resolvedBetsCount: whale.resolvedBetsCount,
      winRate: whale.winRate,
      category: eligibility.translation.marketPlain,
    },
    { lastTemplateFamily, random: () => 0.42 }
  );

  console.log("Template family:", template.templateFamily);
  console.log("Template variant:", template.variantId);
  console.log("Rendered draft:\n", template.renderedDraft);

  if (!isPrismaEnabled()) {
    throw new Error("DATABASE_URL is not set");
  }

  const prisma = getPrisma();
  if (!prisma) {
    throw new Error("Prisma client is not available");
  }

  await ensureVariantIdColumn(prisma);

  const registry = await ensureWhaleInRegistry(MOCK.walletAddress, {
    pseudonym: MOCK.whalePseudonym,
    avgEv: whale.avgEv,
    avgStakeNotional: whale.avgStakeNotional,
  });
  if (!registry) {
    throw new Error("Failed to upsert whale_registry row");
  }

  console.log("\n=== [test:pipeline] Step 4 — Insert x_post_queue ===");
  const queueId = randomUUID();
  const reviewToken = randomUUID();

  const queued = await prisma.xPostQueue.create({
    data: {
      id: queueId,
      walletAddress: MOCK.walletAddress,
      tradeId: payload.tradeId,
      templateFamily: template.templateFamily,
      variantId: template.variantId,
      copyText: template.renderedDraft,
      marketSlug: payload.marketSlug,
      side: eligibility.translation.side,
      entryCents: payload.entryCents,
      nowCents: payload.nowCents,
      stakeNotional: payload.stakeNotional,
      status: "PENDING_REVIEW",
      reviewToken,
    },
  });

  console.log(
    `[test:pipeline] ✓ Queued id=${queued.id} tradeId=${queued.tradeId} status=${queued.status}`
  );

  const approveUrl = buildQueueActionUrl(queued.id, "approve");
  const rejectUrl = buildQueueActionUrl(queued.id, "reject");

  console.log("\n=== [test:pipeline] Step 5 — Review email ===");
  const emailResult = await sendReviewEmail({
    id: queued.id,
    copyText: queued.copyText,
    renderedDraft: queued.copyText,
    templateFamily: template.templateFamily,
    variantId: template.variantId,
    stakeNotional: queued.stakeNotional,
    evPercent: MOCK.tradeEvPercent,
    marketTitle: eligibility.translation.marketPlain,
  });

  if (!emailResult.sent) {
    throw new Error(
      emailResult.skipped
        ? `Email skipped: ${emailResult.error ?? "unknown"}`
        : `Email failed: ${emailResult.error ?? "unknown"}`
    );
  }

  console.log("[test:pipeline] ✓ Review email sent");
  console.log("Approve:", approveUrl);
  console.log("Reject:", rejectUrl);
  console.log("\n[test:pipeline] Done — full pipeline simulation complete");
}

main()
  .catch((error) => {
    console.error("[test:pipeline] Failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectPrisma();
  });
