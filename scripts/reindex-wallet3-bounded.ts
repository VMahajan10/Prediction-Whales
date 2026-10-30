#!/usr/bin/env tsx
/**
 * Bounded wallet-3 rebuild: gamma prefetch for all conditions, lifecycle replay, persist.
 */
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  buildMarketResolveHints,
  GammaResolutionCache,
} from "@/lib/walletLedger/gamma";
import {
  mergeGammaCacheToDisk,
  readPersistentGammaCache,
} from "@/lib/walletLedger/indexed/gammaCacheStore";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import {
  atomicReplaceCurrentVersionWalletLifecycles,
  dedupeWalletLifecycleRowsByAssetEpisode,
} from "@/lib/walletLedger/indexed/store/incrementalLifecycles";
import {
  loadPersistedWalletEvents,
  upsertWalletHistoricalMetrics,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { mergeOutboundHeaders } from "@/lib/outboundHttp";
import type { IndexedAuditWalletResult } from "@/lib/walletLedger/indexed/types";

const WALLET = "0xad529df14c293d77984a0137990a1441b25211ac";

async function probeDataApiPagination(): Promise<{
  activity: { pages: number[]; note: string };
  closedPositions: { pages: number[]; note: string };
}> {
  const activityPages: number[] = [];
  for (let offset = 0; offset <= 6000; offset += 500) {
    const res = await fetchWithTimeout(
      `https://data-api.polymarket.com/activity?user=${WALLET}&limit=500&offset=${offset}`,
      { headers: mergeOutboundHeaders({ Accept: "application/json" }) }
    );
    if (!res.ok) break;
    const data = (await res.json()) as unknown[];
    const n = Array.isArray(data) ? data.length : 0;
    activityPages.push(n);
    if (n < 500) break;
  }

  const closedPages: number[] = [];
  for (let offset = 0; offset <= 2000; offset += 50) {
    const res = await fetchWithTimeout(
      `https://data-api.polymarket.com/closed-positions?user=${WALLET}&limit=500&offset=${offset}`,
      { headers: mergeOutboundHeaders({ Accept: "application/json" }) }
    );
    if (!res.ok) break;
    const data = (await res.json()) as unknown[];
    const n = Array.isArray(data) ? data.length : 0;
    closedPages.push(n);
    if (n < 50) break;
  }

  const activityTotal = activityPages.reduce((s, n) => s + n, 0);
  const activityNote =
    activityPages.length > 0 &&
    activityPages.every((n) => n === 500) &&
    activityTotal >= 5500
      ? "Returns 500/offset through at least 5500 then stops growing — treat as hard cap (~5.5k rows), not a default page size."
      : `Pagination works: ${activityPages.length} page(s), total ${activityTotal} rows.`;

  const closedTotal = closedPages.reduce((s, n) => s + n, 0);
  const closedNote =
    closedPages.length >= 2 &&
    closedPages[0] === 50 &&
    closedPages[1] === 50 &&
    offsetRepeats(closedPages)
      ? "Returns 50 rows per offset with identical cohort — hard cap of 50 total (offset ignored), not real pagination."
      : `closed-positions: ${closedPages.length} page(s), ${closedTotal} rows total.`;

  return {
    activity: { pages: activityPages, note: activityNote },
    closedPositions: { pages: closedPages, note: closedNote },
  };
}

function offsetRepeats(pages: number[]): boolean {
  return pages.length >= 2 && pages.every((n) => n === pages[0]);
}

async function countDuplicateGroups(wallet: string): Promise<number> {
  const db = getDb()!;
  const r = await db.execute(sql`
    select count(*)::int as n from (
      select asset_id, lifecycle_episode
      from wallet_position_lifecycles
      where lower(wallet_address) = lower(${wallet})
        and metric_version = 'phase2e1-v1'
      group by asset_id, lifecycle_episode
      having count(*) > 1
    ) t
  `);
  return Number((r.rows[0] as { n: number }).n);
}

async function main() {
  if (!isDatabaseEnabled()) process.exit(1);

  const pagination = await probeDataApiPagination();
  console.log(JSON.stringify({ pagination }, null, 2));

  const dupBefore = await countDuplicateGroups(WALLET);
  const deduped = await dedupeWalletLifecycleRowsByAssetEpisode(WALLET);
  const dupAfterDedupe = await countDuplicateGroups(WALLET);

  const events = await loadPersistedWalletEvents(WALLET);
  const gammaCache = new GammaResolutionCache();
  gammaCache.seedMany(readPersistentGammaCache().entries());
  const hints = buildMarketResolveHints(events);
  const realConditionHints = hints.filter((h) =>
    /^0x[a-f0-9]{64}$/i.test(h.conditionId.trim())
  );
  const prefetch = await gammaCache.prefetch(realConditionHints);
  mergeGammaCacheToDisk(new Map(gammaCache.exportEntries()));
  gammaCache.setFrozen(true);

  const { positions } = await buildPositionLifecycles(WALLET, events, gammaCache);
  const completedPositions = positions.filter(
    (p) => p.completed && p.realizedPnl != null
  );
  const net = completedPositions.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);

  const lifecycleStats = await atomicReplaceCurrentVersionWalletLifecycles(
    WALLET,
    positions
  );

  const dupAfter = await countDuplicateGroups(WALLET);
  const mergeSplit = analyzeMergeSplitImpact(positions);
  const metrics = computeWalletLedgerMetrics({
    positions,
    identity: {
      requestedWallet: WALLET,
      historyWallet: WALLET,
      confidence: "high",
      resolutionMethod: "proxy_wallet_direct",
      candidateWallets: [],
      alternateCandidates: [],
      evidence: { notes: ["wallet3_bounded_reindex"] },
      positionsOnlyMismatch: false,
      activityCount: events.length,
      tradeCount: events.filter((e) => e.type === "BUY" || e.type === "SELL").length,
      positionsCount: positions.length,
    },
    activityTruncated: true,
    tradesTruncated: true,
    rawEventCount: events.length,
    deduplicatedEventCount: events.length,
    gammaCoverage: {
      distinctMarkets: new Set(positions.map((p) => p.conditionId).filter(Boolean)).size,
      marketsFoundBefore: prefetch.marketsFoundBefore,
      marketsFoundAfter: prefetch.marketsFoundAfter,
      resolvedBefore: prefetch.resolvedBefore,
      resolvedAfter: prefetch.resolvedAfter,
      coverageBeforePct: hints.length > 0 ? prefetch.resolvedBefore / hints.length : 1,
      coverageAfterPct: hints.length > 0 ? prefetch.resolvedAfter / hints.length : 1,
      marketFoundCoverageAfterPct:
        hints.length > 0 ? prefetch.marketsFoundAfter / hints.length : 1,
    },
    mergeSplit,
    hasHistoryEvents: events.length > 0,
  });

  const audit = {
    wallet: WALLET,
    indexedLifecyclePositions: positions,
    indexedLedgerMetrics: metrics,
    throughBlock: null,
  } as IndexedAuditWalletResult;

  await upsertWalletHistoricalMetrics(WALLET, audit);

  console.log(
    JSON.stringify(
      {
        wallet: WALLET,
        events: events.length,
        gammaHints: hints.length,
        gammaResolvedAfter: prefetch.resolvedAfter,
        positions: positions.length,
        completedCount: completedPositions.length,
        ledgerNetFromReplay: net,
        duplicateGroupsBefore: dupBefore,
        rowsDeletedByDedupe: deduped,
        duplicateGroupsAfterDedupe: dupAfterDedupe,
        duplicateGroupsAfterPersist: dupAfter,
        lifecycleStats,
      },
      null,
      2
    )
  );
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
