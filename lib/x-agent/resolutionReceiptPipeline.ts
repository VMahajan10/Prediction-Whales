import { randomUUID } from "node:crypto";
import "server-only";

import { and, eq, isNull, not, sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { xPostQueue, type XPostQueue } from "@/lib/crossmarket/store/schema";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";
import { isMarketResolvedYesForSide } from "@/lib/x-agent/marketResolution";
import { ensureXPostQueueSchemaOnce } from "@/lib/x-agent/ensureXPostQueueSchema";
import { fetchLastEvGloss, persistLastEvGloss } from "@/lib/x-agent/evGlossStore";
import { getWhaleAlias } from "@/lib/x-agent/getWhaleAlias";
import { selectResolutionReceiptTemplate } from "@/lib/x-agent/templateEngine";
import { refreshTemplateCopyCache } from "@/lib/templates/templateCopyStore";
import { formatWhaleDisplayLabel } from "@/lib/x-agent/whaleDisplay";
import {
  fetchLastSentenceOrderIndex,
  fetchLastTemplateFamily,
  fetchLastVariantId,
} from "@/lib/templates/queueHelpers";
import { findWhaleByWallet } from "@/lib/x-agent/whaleRegistryDb";
import { POST_STATUS } from "@/lib/x-agent/postStatus";

export interface ResolutionReceiptScanResult {
  scanned: number;
  enqueued: number;
  skipped: number;
  errors: string[];
}

async function listPublishedPostsAwaitingReceipt(): Promise<XPostQueue[]> {
  if (!isDatabaseEnabled()) return [];
  const db = getDb();

  const rows = await db
    .select()
    .from(xPostQueue)
    .where(
      and(
        eq(xPostQueue.status, POST_STATUS.PUBLISHED),
        not(eq(xPostQueue.templateFamily, "V8")),
        isNull(xPostQueue.receiptForQueueId)
      )
    )
    .orderBy(sql`${xPostQueue.createdAt} DESC`)
    .limit(50);

  const awaiting: XPostQueue[] = [];
  for (const row of rows) {
    const [existingReceipt] = await db
      .select({ id: xPostQueue.id })
      .from(xPostQueue)
      .where(eq(xPostQueue.receiptForQueueId, row.id))
      .limit(1);
    if (!existingReceipt) awaiting.push(row);
  }
  return awaiting;
}

export async function enqueueResolutionReceiptForPublishedPost(
  published: XPostQueue
): Promise<{ ok: true; queueId: string } | { ok: false; reason: string }> {
  if (!isPrismaEnabled()) {
    return { ok: false, reason: "prisma_disabled" };
  }
  const prisma = getPrisma();
  if (!prisma) return { ok: false, reason: "prisma_unavailable" };

  await ensureXPostQueueSchemaOnce(prisma);

  const duplicate = await prisma.xPostQueue.findFirst({
    where: { receiptForQueueId: published.id },
    select: { id: true },
  });
  if (duplicate) {
    return { ok: false, reason: "duplicate_receipt" };
  }

  const resolved = await isMarketResolvedYesForSide(
    published.marketSlug,
    published.side
  );
  if (!resolved) {
    return { ok: false, reason: "market_not_resolved_yes" };
  }

  const whaleRow = await findWhaleByWallet(published.walletAddress);
  if (!whaleRow) {
    return { ok: false, reason: "whale_not_in_registry" };
  }

  const whaleLabel =
    (await getWhaleAlias(published.walletAddress)) ??
    formatWhaleDisplayLabel(published.walletAddress, whaleRow.pseudonym);

  const gainCents = Math.max(0, Math.round(100 - published.entryCents));

  const lastTemplateFamily = await fetchLastTemplateFamily(prisma);
  const lastVariantId = await fetchLastVariantId(prisma);
  const lastSentenceOrderIndex = await fetchLastSentenceOrderIndex(prisma);
  const lastEvGloss = await fetchLastEvGloss(prisma);

  let templateSelection;
  try {
    await refreshTemplateCopyCache();
    templateSelection = selectResolutionReceiptTemplate(
      {
        whale: whaleLabel,
        side: published.side,
        entry: published.entryCents,
        now: 100,
        stakeNotional: published.stakeNotional,
        avg_ev: whaleRow.avgEv,
        avgStakeNotional: whaleRow.avgStakeNotional,
        resolvedBetsCount: whaleRow.resolvedBetsCount,
        winRate: whaleRow.winRate,
        gainCents,
      },
      {
        lastTemplateFamily,
        lastVariantId,
        lastSentenceOrderIndex,
        lastEvGloss,
      }
    );
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error ? error.message : "template_selection_failed",
    };
  }

  const tradeId = `receipt:${published.id}`;
  const queueId = randomUUID();

  try {
    await prisma.xPostQueue.create({
      data: {
        id: queueId,
        walletAddress: published.walletAddress,
        tradeId,
        templateFamily: templateSelection.templateFamily,
        variantId: templateSelection.variantId,
        evGloss: templateSelection.evGloss,
        copyText: templateSelection.renderedDraft,
        marketSlug: published.marketSlug,
        side: published.side,
        entryCents: published.entryCents,
        nowCents: 100,
        stakeNotional: published.stakeNotional,
        status: "PENDING_REVIEW",
        reviewToken: randomUUID(),
        sentenceOrderIndex: templateSelection.sentenceOrderIndex,
        receiptForQueueId: published.id,
      },
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "queue_insert_failed",
    };
  }

  await persistLastEvGloss(templateSelection.evGloss).catch(() => undefined);

  return { ok: true, queueId };
}

export async function scanResolutionReceipts(): Promise<ResolutionReceiptScanResult> {
  const result: ResolutionReceiptScanResult = {
    scanned: 0,
    enqueued: 0,
    skipped: 0,
    errors: [],
  };

  try {
    const candidates = await listPublishedPostsAwaitingReceipt();
    result.scanned = candidates.length;

    for (const published of candidates) {
      const outcome = await enqueueResolutionReceiptForPublishedPost(published);
      if (outcome.ok) {
        result.enqueued += 1;
      } else if (
        outcome.reason === "market_not_resolved_yes" ||
        outcome.reason === "duplicate_receipt"
      ) {
        result.skipped += 1;
      } else {
        result.skipped += 1;
        result.errors.push(`${published.id}:${outcome.reason}`);
      }
    }
  } catch (error) {
    result.errors.push(
      error instanceof Error ? error.message : String(error)
    );
  }

  return result;
}
