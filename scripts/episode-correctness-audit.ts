#!/usr/bin/env tsx
/**
 * Offline episode correctness audit — read-only, no hydration.
 */
import "../tests/preload-env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletLedgerEvents,
  walletPositionLifecycles,
} from "@/lib/crossmarket/store/schema";
import { SHARE_BALANCE_EPSILON } from "@/lib/walletLedger/constants";
import {
  buildPositionLifecycles,
  buildTimelineState,
  splitEventsIntoEpisodes,
} from "@/lib/walletLedger/ledger";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { positionKey } from "@/lib/walletLedger/normalize";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

type PositionGroup = {
  conditionId: string;
  asset: string;
  events: WalletLedgerEvent[];
};

function isFullyExited(shares: number): boolean {
  return Math.abs(shares) <= SHARE_BALANCE_EPSILON;
}

function groupEventsByPosition(events: WalletLedgerEvent[]): PositionGroup[] {
  const map = new Map<string, WalletLedgerEvent[]>();
  for (const event of events) {
    if (!event.conditionId && !event.asset) continue;
    const key = positionKey(event);
    const list = map.get(key) ?? [];
    list.push(event);
    map.set(key, list);
  }
  return [...map.entries()].map(([key, evs]) => {
    const [conditionId, asset] = key.split("::");
    return {
      conditionId,
      asset,
      events: [...evs].sort((a, b) => a.timestamp - b.timestamp),
    };
  });
}

function countExpectedCompletedEpisodes(group: PositionGroup): {
  expectedEpisodes: number;
  expectedCompleted: number;
  zeroThenReentry: number;
  buySellNeverZero: number;
  mergeSplit: boolean;
  episodeDetails: Array<{
    episode: number;
    eventCount: number;
    completed: boolean;
    finalShares: number;
    grossBuyCash: number;
    firstTs: number;
    lastTs: number;
  }>;
  zeroPoints: Array<{ eventIndex: number; timestamp: number; nextType: string | null }>;
} {
  const mergeSplit = group.events.some(
    (e) => e.type === "MERGE" || e.type === "SPLIT"
  );
  const episodes = splitEventsIntoEpisodes(group.events);
  const episodeDetails = episodes.map((episodeEvents, idx) => {
    const state = buildTimelineState(episodeEvents);
    const completed =
      isFullyExited(state.shares) && state.grossBuyCash > SHARE_BALANCE_EPSILON;
    return {
      episode: idx,
      eventCount: episodeEvents.length,
      completed,
      finalShares: state.shares,
      grossBuyCash: state.grossBuyCash,
      firstTs: episodeEvents[0]?.timestamp ?? 0,
      lastTs: episodeEvents[episodeEvents.length - 1]?.timestamp ?? 0,
    };
  });

  let zeroThenReentry = 0;
  let buySellNeverZero = 0;
  const zeroPoints: Array<{
    eventIndex: number;
    timestamp: number;
    nextType: string | null;
  }> = [];

  if (!mergeSplit) {
    let state = {
      shares: 0,
      grossBuyCash: 0,
      grossSellCash: 0,
      redeemCash: 0,
      cashOutlay: 0,
      maxCashOutlay: 0,
    };
    const hasBuy = group.events.some((e) => e.type === "BUY");
    const hasSell = group.events.some((e) => e.type === "SELL");

    for (let i = 0; i < group.events.length; i += 1) {
      const event = group.events[i];
      const priorShares = state.shares;
      state = buildTimelineState(group.events.slice(0, i + 1));
      const reachedZero =
        isFullyExited(state.shares) && state.grossBuyCash > SHARE_BALANCE_EPSILON;
      if (reachedZero && !isFullyExited(priorShares)) {
        const next = group.events[i + 1];
        zeroPoints.push({
          eventIndex: i,
          timestamp: event.timestamp,
          nextType: next?.type ?? null,
        });
        if (next?.type === "BUY") zeroThenReentry += 1;
      }
    }

    if (hasBuy && hasSell) {
      const final = buildTimelineState(group.events);
      if (
        !isFullyExited(final.shares) &&
        final.grossSellCash > 0 &&
        final.grossBuyCash > 0
      ) {
        buySellNeverZero += 1;
      }
    }
  }

  return {
    expectedEpisodes: episodes.length,
    expectedCompleted: episodeDetails.filter((e) => e.completed).length,
    zeroThenReentry,
    buySellNeverZero,
    mergeSplit,
    episodeDetails,
    zeroPoints,
  };
}

function credibleFilter(p: {
  completed: boolean;
  excludedFromMetrics?: boolean;
  realizedPnl: number | null;
  completionReason: string | null;
  resolution?: { resolutionFinal?: boolean } | null;
}) {
  return (
    p.completed &&
    !p.excludedFromMetrics &&
    p.realizedPnl != null &&
    (p.completionReason === "fully_exited" ||
      p.resolution?.resolutionFinal === true)
  );
}

function lifecycleSignature(
  positions: Awaited<ReturnType<typeof buildPositionLifecycles>>["positions"]
) {
  return positions
    .map(
      (p) =>
        `${p.conditionId}::${p.asset}::${p.lifecycleEpisode}:${p.completed ? 1 : 0}:${p.realizedPnl ?? "null"}`
    )
    .sort()
    .join("\n");
}

async function auditWallet(wallet: string) {
  const db = getDb();
  const events = await loadPersistedWalletEvents(wallet);
  const groups = groupEventsByPosition(events);

  let rawExpectedCompleted = 0;
  let rawExpectedEpisodes = 0;
  let zeroReentryPositions = 0;
  let buySellNeverZeroPositions = 0;
  let mergeSplitPositions = 0;

  const completedEpisodeSamples: Array<{
    conditionId: string;
    asset: string;
    episodes: ReturnType<typeof countExpectedCompletedEpisodes>["episodeDetails"];
  }> = [];

  for (const group of groups) {
    const analysis = countExpectedCompletedEpisodes(group);
    rawExpectedCompleted += analysis.expectedCompleted;
    rawExpectedEpisodes += analysis.expectedEpisodes;
    zeroReentryPositions += analysis.zeroThenReentry > 0 ? 1 : 0;
    buySellNeverZeroPositions += analysis.buySellNeverZero;
    if (analysis.mergeSplit) mergeSplitPositions += 1;
    if (analysis.expectedCompleted > 0) {
      completedEpisodeSamples.push({
        conditionId: group.conditionId,
        asset: group.asset,
        episodes: analysis.episodeDetails.filter((e) => e.completed),
      });
    }
  }

  const run1 = await buildPositionLifecycles(wallet, events);
  const run2 = await buildPositionLifecycles(wallet, events);

  const reconstructedCompleted = run1.positions.filter(
    (p) => p.completed && p.realizedPnl != null
  );
  const reconstructedCredible = run1.positions.filter(credibleFilter);
  const observedCompleted = run1.positions.filter(
    (p) => p.completed && p.realizedPnl != null
  );

  const [metricsRow] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      sql`${walletHistoricalMetrics.walletAddress} = ${wallet} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
    )
    .limit(1);

  const persistedRows = await db
    .select()
    .from(walletPositionLifecycles)
    .where(
      and(
        eq(walletPositionLifecycles.walletAddress, wallet),
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    );

  const persistedCompleted = persistedRows.filter((r) => r.completed);
  const persistedByEpisode = new Map(
    persistedRows.map((r) => [
      `${r.conditionId}::${r.assetId}::${r.lifecycleEpisode}`,
      r,
    ])
  );

  const reconstructedByEpisode = new Map(
    run1.positions.map((p) => [
      `${p.conditionId}::${p.asset}::${p.lifecycleEpisode}`,
      p,
    ])
  );

  let persistedMismatch = 0;
  for (const [key, row] of persistedByEpisode) {
    const computed = reconstructedByEpisode.get(key);
    if (!computed) {
      persistedMismatch += 1;
      continue;
    }
    if (computed.completed !== row.completed) persistedMismatch += 1;
  }
  for (const key of reconstructedByEpisode.keys()) {
    if (!persistedByEpisode.has(key)) persistedMismatch += 1;
  }

  const idempotent =
    lifecycleSignature(run1.positions) === lifecycleSignature(run2.positions);

  const episodeNumberingStable = run1.positions.every((p) => {
    const match = run2.positions.find(
      (q) =>
        q.conditionId === p.conditionId &&
        q.asset === p.asset &&
        q.lifecycleEpisode === p.lifecycleEpisode
    );
    return (
      match != null &&
      match.completed === p.completed &&
      match.realizedPnl === p.realizedPnl
    );
  });

  const duplicateRows = await db
    .select({
      conditionId: walletPositionLifecycles.conditionId,
      assetId: walletPositionLifecycles.assetId,
      lifecycleEpisode: walletPositionLifecycles.lifecycleEpisode,
      count: sql<number>`count(*)::int`,
    })
    .from(walletPositionLifecycles)
    .where(
      and(
        eq(walletPositionLifecycles.walletAddress, wallet),
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .groupBy(
      walletPositionLifecycles.conditionId,
      walletPositionLifecycles.assetId,
      walletPositionLifecycles.lifecycleEpisode
    )
    .having(sql`count(*) > 1`);

  const eventCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletLedgerEvents)
    .where(eq(walletLedgerEvents.walletAddress, wallet));

  const fe787dSingleCompleted =
    wallet === "0xfe787d2da716d60e8acff57fb87eb13cd4d10319"
      ? completedEpisodeSamples
      : null;

  const fe787dZeroReentryDetail =
    wallet === "0xfe787d2da716d60e8acff57fb87eb13cd4d10319"
      ? groups
          .filter((g) => {
            const a = countExpectedCompletedEpisodes(g);
            return a.zeroThenReentry > 0 || a.buySellNeverZero > 0;
          })
          .slice(0, 5)
          .map((g) => ({
            conditionId: g.conditionId.slice(0, 16),
            asset: g.asset.slice(0, 16),
            ...countExpectedCompletedEpisodes(g),
          }))
      : null;

  const recovered526 =
    wallet === "0x5268527977f700f9bf9b6d5cd843859e4e70135d"
      ? reconstructedCredible.map((p) => ({
          conditionId: p.conditionId.slice(0, 16),
          asset: p.asset.slice(0, 16),
          episode: p.lifecycleEpisode,
          realizedPnl: p.realizedPnl,
          completionReason: p.completionReason,
          excluded: p.excludedFromMetrics,
          exclusionReason: p.exclusionReason,
        }))
      : null;

  return {
    wallet,
    ledgerEventCount: eventCount[0]?.count ?? 0,
    positionGroups: groups.length,
    counts: {
      rawExpectedCompleted,
      rawExpectedEpisodes,
      reconstructedObserved: observedCompleted.length,
      reconstructedCredible: reconstructedCredible.length,
      persistedCompleted: persistedCompleted.length,
      persistedTotalRows: persistedRows.length,
      metricsCompletedPositions: metricsRow?.completedPositions ?? null,
      metricsHistoryValidity: metricsRow?.historyValidity ?? null,
    },
    positionPatterns: {
      zeroReentryPositions,
      buySellNeverZeroPositions,
      mergeSplitPositions,
    },
    idempotence: {
      identicalRuns: idempotent,
      episodeNumberingStable,
      duplicatePersistedRows: duplicateRows.length,
      persistedVsReconstructedMismatches: persistedMismatch,
    },
    recovered526,
    fe787dSingleCompleted,
    fe787dZeroReentryDetail,
    completedEpisodeSamples: completedEpisodeSamples.slice(0, 15),
  };
}

async function main() {
  const results = [];
  for (const wallet of [
    "0x5268527977f700f9bf9b6d5cd843859e4e70135d",
    "0xfe787d2da716d60e8acff57fb87eb13cd4d10319",
  ]) {
    results.push(await auditWallet(wallet));
  }
  console.log(JSON.stringify({ mode: "episode_correctness_audit", results }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
