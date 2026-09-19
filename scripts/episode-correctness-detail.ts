#!/usr/bin/env tsx
import "../tests/preload-env";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import {
  buildPositionLifecycles,
  splitEventsIntoEpisodes,
  buildTimelineState,
} from "@/lib/walletLedger/ledger";
import { positionKey } from "@/lib/walletLedger/normalize";
import { SHARE_BALANCE_EPSILON } from "@/lib/walletLedger/constants";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletPositionLifecycles } from "@/lib/crossmarket/store/schema";
import { and, eq } from "drizzle-orm";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";

const wallet526 = "0x5268527977f700f9bf9b6d5cd843859e4e70135d";
const walletFe = "0xfe787d2da716d60e8acff57fb87eb13cd4d10319";

function groupEvents(events: WalletLedgerEvent[]) {
  const map = new Map<string, WalletLedgerEvent[]>();
  for (const event of events) {
    const key = positionKey(event);
    const list = map.get(key) ?? [];
    list.push(event);
    map.set(key, list);
  }
  return map;
}

function credible(p: {
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

async function analyze526() {
  const events = await loadPersistedWalletEvents(wallet526);
  const { positions } = await buildPositionLifecycles(wallet526, events);
  const observed = positions.filter((p) => p.completed && p.realizedPnl != null);
  const crediblePositions = positions.filter(credible);
  const excluded = observed.filter((p) => p.excludedFromMetrics);

  const zeroReentry: Array<Record<string, unknown>> = [];
  for (const [key, evs] of groupEvents(events)) {
    const sorted = [...evs].sort((a, b) => a.timestamp - b.timestamp);
    const episodes = splitEventsIntoEpisodes(sorted);
    if (episodes.length <= 1) continue;
    const ep0State = buildTimelineState(episodes[0]);
    if (
      Math.abs(ep0State.shares) <= SHARE_BALANCE_EPSILON &&
      ep0State.grossBuyCash > SHARE_BALANCE_EPSILON
    ) {
      const lifecycleEp0 = positions.find(
        (p) =>
          positionKey(p) === key && p.lifecycleEpisode === 0 && p.completed
      );
      zeroReentry.push({
        asset: key.split("::")[1],
        episodes: episodes.length,
        ep0EventCount: episodes[0].length,
        ep0GrossBuy: ep0State.grossBuyCash,
        ep0RealizedPnl: lifecycleEp0?.realizedPnl ?? null,
        ep0Excluded: lifecycleEp0?.excludedFromMetrics ?? null,
        ep1FirstEvent: episodes[1][0]?.type,
        ep1FirstTs: episodes[1][0]?.timestamp,
      });
    }
  }

  return {
    wallet: wallet526,
    observedCompleted: observed.length,
    credibleCompleted: crediblePositions.length,
    excluded,
    zeroReentry,
  };
}

async function analyzeFe() {
  const events = await loadPersistedWalletEvents(walletFe);
  const asset =
    "44707399190353569768263358994564398407141184715702050381076208690306332318499";
  const posEvents = events
    .filter((e) => e.asset === asset)
    .sort((a, b) => a.timestamp - b.timestamp);

  let buySellNeverZero = 0;
  let zeroReentryCount = 0;
  let trueZeroBeforeReentry = 0;

  for (const [, evs] of groupEvents(events)) {
    const sorted = [...evs].sort((a, b) => a.timestamp - b.timestamp);
    const hasBuy = sorted.some((e) => e.type === "BUY");
    const hasSell = sorted.some((e) => e.type === "SELL");
    const final = buildTimelineState(sorted);
    if (
      hasBuy &&
      hasSell &&
      Math.abs(final.shares) > SHARE_BALANCE_EPSILON
    ) {
      buySellNeverZero += 1;
    }

    const episodes = splitEventsIntoEpisodes(sorted);
    if (episodes.length > 1) zeroReentryCount += 1;

    let state = buildTimelineState([]);
    for (let i = 0; i < sorted.length; i += 1) {
      const prior = state.shares;
      state = buildTimelineState(sorted.slice(0, i + 1));
      const reachedZero =
        Math.abs(state.shares) <= SHARE_BALANCE_EPSILON &&
        state.grossBuyCash > SHARE_BALANCE_EPSILON;
      if (reachedZero && Math.abs(prior) > SHARE_BALANCE_EPSILON) {
        const next = sorted[i + 1];
        if (next?.type === "BUY") trueZeroBeforeReentry += 1;
      }
    }
  }

  return {
    wallet: walletFe,
    completedAssetEvents: posEvents.map((e) => ({
      type: e.type,
      shares: e.shares,
      usdcAmount: e.usdcAmount,
      timestamp: e.timestamp,
      tx: e.transactionHash?.slice(0, 14),
    })),
    buySellNeverZero,
    zeroReentryPositions: zeroReentryCount,
    trueZeroBeforeReentryEvents: trueZeroBeforeReentry,
  };
}

async function checkPersistedAlignment(wallet: string) {
  const events = await loadPersistedWalletEvents(wallet);
  const { positions } = await buildPositionLifecycles(wallet, events);
  const db = getDb();
  const persisted = await db
    .select()
    .from(walletPositionLifecycles)
    .where(
      and(
        eq(walletPositionLifecycles.walletAddress, wallet),
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    );

  const reconKeys = new Set(
    positions.map(
      (p) => `${p.conditionId}::${p.asset}::${p.lifecycleEpisode}`
    )
  );
  const persistedKeys = new Set(
    persisted.map(
      (r) => `${r.conditionId}::${r.assetId}::${r.lifecycleEpisode}`
    )
  );

  const onlyPersisted = [...persistedKeys].filter((k) => !reconKeys.has(k));
  const onlyRecon = [...reconKeys].filter((k) => !persistedKeys.has(k));

  const completedPersisted = persisted.filter((r) => r.completed);
  const completedRecon = positions.filter((p) => p.completed);
  let completedMismatch = 0;
  for (const row of completedPersisted) {
    const key = `${row.conditionId}::${row.assetId}::${row.lifecycleEpisode}`;
    const match = positions.find(
      (p) =>
        `${p.conditionId}::${p.asset}::${p.lifecycleEpisode}` === key
    );
    if (!match || match.completed !== row.completed) completedMismatch += 1;
  }

  return {
    wallet,
    persistedRows: persisted.length,
    reconstructedRows: positions.length,
    onlyPersistedCount: onlyPersisted.length,
    onlyReconCount: onlyRecon.length,
    onlyPersistedSample: onlyPersisted.slice(0, 5),
    onlyReconSample: onlyRecon.slice(0, 5),
    completedPersisted: completedPersisted.length,
    completedRecon: completedRecon.length,
    completedMismatch,
  };
}

async function fe787dEpisodeProof() {
  const events = await loadPersistedWalletEvents(walletFe);
  const asset =
    "44707399190353569768263358994564398407141184715702050381076208690306332318499";
  const posEvents = events
    .filter((e) => e.asset === asset)
    .sort((a, b) => a.timestamp - b.timestamp);
  const episodes = splitEventsIntoEpisodes(posEvents);
  const { positions } = await buildPositionLifecycles(walletFe, events);
  return {
    episodes: episodes.map((ep, i) => ({
      episode: i,
      events: ep.map((e) => ({
        type: e.type,
        shares: e.shares,
        cashUsd: e.cashUsd,
        timestamp: e.timestamp,
      })),
      finalState: buildTimelineState(ep),
    })),
    lifecycles: positions
      .filter((p) => p.asset === asset)
      .map((p) => ({
        episode: p.lifecycleEpisode,
        completed: p.completed,
        realizedPnl: p.realizedPnl,
        excluded: p.excludedFromMetrics,
        netShares: p.netShares,
      })),
  };
}

async function main() {
  const out = {
    detail526: await analyze526(),
    detailFe: await analyzeFe(),
    fe787dProof: await fe787dEpisodeProof(),
    persist526: await checkPersistedAlignment(wallet526),
    persistFe: await checkPersistedAlignment(walletFe),
  };
  console.log(JSON.stringify(out, null, 2));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
