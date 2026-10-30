import { SHARE_BALANCE_EPSILON } from "@/lib/walletLedger/constants";
import { sortLedgerEventsCanonical } from "@/lib/walletLedger/eventOrder";
import { GammaResolutionCache, isWinningAsset } from "@/lib/walletLedger/gamma";
import {
  canonicalConditionIdForEvents,
  lifecycleAssetKey,
} from "@/lib/walletLedger/normalize";
import type {
  GammaMarketResolution,
  PositionLifecycle,
  WalletLedgerEvent,
} from "@/lib/walletLedger/types";

interface TimelineState {
  shares: number;
  cashOutlay: number;
  maxCashOutlay: number;
  grossBuyCash: number;
  grossSellCash: number;
  redeemCash: number;
}

function applyEvent(state: TimelineState, event: WalletLedgerEvent): TimelineState {
  const next = { ...state };
  const shares = Number(event.shares ?? 0);
  const cash = Number(event.cashUsd ?? 0);

  switch (event.type) {
    case "BUY":
      next.shares += shares;
      next.cashOutlay += cash;
      next.grossBuyCash += cash;
      break;
    case "SELL":
      next.shares -= shares;
      next.cashOutlay -= cash;
      next.grossSellCash += cash;
      break;
    case "REDEEM":
      next.shares = 0;
      next.cashOutlay -= cash;
      next.redeemCash += cash;
      break;
    case "SPLIT": {
      if (shares > 0) {
        next.shares += shares;
        if (cash > 0) {
          next.cashOutlay += cash;
          next.grossBuyCash += cash;
        }
      }
      break;
    }
    case "MERGE": {
      if (shares > 0 && next.shares > SHARE_BALANCE_EPSILON) {
        const merged = Math.min(shares, next.shares);
        const costReleased =
          next.cashOutlay * (merged / Math.max(next.shares, merged));
        next.shares -= merged;
        next.cashOutlay = Math.max(0, next.cashOutlay - costReleased);
        if (cash > 0) {
          next.grossSellCash += cash;
          next.cashOutlay -= cash;
        }
      }
      break;
    }
    default:
      break;
  }

  next.maxCashOutlay = Math.max(next.maxCashOutlay, next.cashOutlay);
  return next;
}

function isFullyExited(shares: number): boolean {
  return Math.abs(shares) <= SHARE_BALANCE_EPSILON;
}

function computeCapitalAtRisk(state: TimelineState): number {
  return Math.max(state.maxCashOutlay, 0);
}

export function buildTimelineState(events: WalletLedgerEvent[]): TimelineState {
  const sorted = sortLedgerEventsCanonical(events);
  let state: TimelineState = {
    shares: 0,
    cashOutlay: 0,
    maxCashOutlay: 0,
    grossBuyCash: 0,
    grossSellCash: 0,
    redeemCash: 0,
  };
  for (const event of sorted) {
    state = applyEvent(state, event);
  }
  return state;
}

function hasMergeOrSplit(events: WalletLedgerEvent[]): boolean {
  return events.some((e) => e.type === "MERGE" || e.type === "SPLIT");
}

function emptyTimelineState(): TimelineState {
  return {
    shares: 0,
    cashOutlay: 0,
    maxCashOutlay: 0,
    grossBuyCash: 0,
    grossSellCash: 0,
    redeemCash: 0,
  };
}

/**
 * Split a single-market timeline into completed episodes when a full exit is
 * followed by a later BUY re-entry. MERGE/SPLIT timelines stay unsplit.
 */
export function splitEventsIntoEpisodes(events: WalletLedgerEvent[]): WalletLedgerEvent[][] {
  const sorted = sortLedgerEventsCanonical(events);
  if (sorted.length === 0) return [];
  if (hasMergeOrSplit(sorted)) return [sorted];

  const episodes: WalletLedgerEvent[][] = [];
  let current: WalletLedgerEvent[] = [];
  let state = emptyTimelineState();

  for (const event of sorted) {
    const priorFullyExited =
      current.length > 0 &&
      isFullyExited(state.shares) &&
      state.grossBuyCash > SHARE_BALANCE_EPSILON;

    if (priorFullyExited && event.type === "BUY") {
      episodes.push(current);
      current = [];
      state = emptyTimelineState();
    }

    current.push(event);
    state = applyEvent(state, event);
  }

  if (current.length > 0) {
    episodes.push(current);
  }

  return episodes.length > 0 ? episodes : [sorted];
}

async function buildPositionLifecycleFromEvents(
  wallet: string,
  conditionId: string,
  asset: string,
  sorted: WalletLedgerEvent[],
  gammaCache: GammaResolutionCache,
  lifecycleEpisode: number
): Promise<PositionLifecycle> {
  const first = sorted[0];
  const slug = first.slug ?? null;

  let accountingStatus: PositionLifecycle["accountingStatus"] = "ok";
  if (hasMergeOrSplit(sorted)) {
    accountingStatus = "requires_merge_split_resolution";
  }

  const state = buildTimelineState(sorted);
  const fullyExited = isFullyExited(state.shares);
  const capitalAtRisk = computeCapitalAtRisk(state);

  const resolutionKey = conditionId.startsWith("unresolved:asset:")
    ? ""
    : conditionId;
  const resolution = resolutionKey
    ? (gammaCache.get(resolutionKey) ??
      (await gammaCache.resolve(resolutionKey, {
        slugs: slug ? [slug] : [],
        assets: asset ? [asset] : [],
      })))
    : (await gammaCache.resolveByAsset(asset, { slugs: slug ? [slug] : [] }));

  let resolutionPayoutUsd = 0;
  let heldThroughResolution = false;
  let completed = false;
  let completionReason: PositionLifecycle["completionReason"] = null;

  if (accountingStatus === "ok") {
    if (fullyExited && state.grossBuyCash > SHARE_BALANCE_EPSILON) {
      completed = true;
      completionReason = "fully_exited";
    } else if (
      resolution?.resolutionFinal &&
      state.grossBuyCash > SHARE_BALANCE_EPSILON
    ) {
      if (state.shares > SHARE_BALANCE_EPSILON) {
        heldThroughResolution = true;
        resolutionPayoutUsd = settlementPayoutUsd(state, resolution, asset);
        completionReason = "held_through_resolution";
      } else {
        resolutionPayoutUsd = 0;
        completionReason = "market_resolved";
      }
      completed = true;
    }
  }

  let realizedPnl: number | null = null;
  let positionRoi: number | null = null;
  let outcomeCorrect: boolean | null = null;
  let excludedFromMetrics = false;
  let exclusionReason: string | null = null;

  if (accountingStatus !== "ok") {
    excludedFromMetrics = true;
    exclusionReason = accountingStatus;
  } else if (capitalAtRisk <= 0 && state.grossBuyCash <= 0) {
    excludedFromMetrics = true;
    exclusionReason = "invalid_capital_accounting";
    accountingStatus = "invalid_capital_accounting";
  } else if (completed) {
    realizedPnl = computeRealizedPnl(state, resolutionPayoutUsd);
    if (capitalAtRisk > 0) {
      positionRoi = realizedPnl / capitalAtRisk;
    } else {
      excludedFromMetrics = true;
      exclusionReason = "invalid_capital_accounting";
      accountingStatus = "invalid_capital_accounting";
    }
    if (heldThroughResolution && resolution?.resolutionFinal) {
      outcomeCorrect = isWinningAsset(resolution, asset);
    }
  } else {
    accountingStatus = "open";
  }

  return {
    wallet,
    conditionId,
    asset,
    lifecycleEpisode,
    title: first.title ?? "Unknown market",
    outcome: first.outcome ?? "",
    slug,
    events: sorted,
    grossBuyCash: state.grossBuyCash,
    grossSellCash: state.grossSellCash,
    redeemCash: state.redeemCash,
    netShares: state.shares,
    maxCumulativeCashOutlay: state.maxCashOutlay,
    firstEntryAt: sorted[0]?.timestamp ?? null,
    lastActivityAt: sorted[sorted.length - 1]?.timestamp ?? null,
    fullyExited,
    accountingStatus,
    completed,
    completionReason,
    resolution,
    resolutionPayoutUsd,
    realizedPnl,
    capitalAtRisk,
    positionRoi,
    heldThroughResolution,
    outcomeCorrect,
    excludedFromMetrics,
    exclusionReason,
  };
}

function settlementPayoutUsd(
  state: TimelineState,
  resolution: GammaMarketResolution | null,
  asset: string
): number {
  if (!resolution?.resolutionFinal) return 0;
  if (state.shares <= SHARE_BALANCE_EPSILON) return 0;

  const winning = isWinningAsset(resolution, asset);
  if (winning === true) return state.shares * 1;
  if (winning === false) return 0;
  return 0;
}

function computeRealizedPnl(
  state: TimelineState,
  resolutionPayoutUsd: number
): number {
  return state.grossSellCash + state.redeemCash + resolutionPayoutUsd - state.grossBuyCash;
}

export interface BuildPositionLifecyclesResult {
  positions: PositionLifecycle[];
  gammaCache: GammaResolutionCache;
}

export async function buildPositionLifecycles(
  wallet: string,
  events: WalletLedgerEvent[],
  gammaCache = new GammaResolutionCache()
): Promise<BuildPositionLifecyclesResult> {
  const grouped = new Map<string, WalletLedgerEvent[]>();
  for (const event of events) {
    const asset = event.asset?.trim();
    if (!asset) continue;
    const key = lifecycleAssetKey(asset);
    const list = grouped.get(key) ?? [];
    list.push(event);
    grouped.set(key, list);
  }

  const positions: PositionLifecycle[] = [];
  const sortedKeys = [...grouped.keys()].sort();

  for (const asset of sortedKeys) {
    const positionEvents = grouped.get(asset)!;
    let conditionId = canonicalConditionIdForEvents(positionEvents);
    if (!conditionId) {
      const slugs = [
        ...new Set(
          positionEvents.map((e) => e.slug?.trim()).filter(Boolean) as string[]
        ),
      ];
      const byAsset = await gammaCache.resolveByAsset(asset, { slugs });
      conditionId = byAsset.conditionId?.trim() ?? "";
    }
    if (!conditionId) {
      conditionId = `unresolved:asset:${asset}`;
    }
    const episodes = splitEventsIntoEpisodes(positionEvents);
    for (let episodeIndex = 0; episodeIndex < episodes.length; episodeIndex += 1) {
      const sorted = sortLedgerEventsCanonical(episodes[episodeIndex]);
      positions.push(
        await buildPositionLifecycleFromEvents(
          wallet,
          conditionId,
          asset,
          sorted,
          gammaCache,
          episodeIndex
        )
      );
    }
  }

  return { positions, gammaCache };
}

/** Exported for unit tests — timeline replay with explicit resolution payout. */
export function computePositionEconomics(
  events: WalletLedgerEvent[],
  resolution: GammaMarketResolution | null,
  asset: string
): {
  state: TimelineState;
  fullyExited: boolean;
  capitalAtRisk: number;
  resolutionPayoutUsd: number;
  realizedPnl: number | null;
  completed: boolean;
} {
  const accountingStatus = hasMergeOrSplit(events)
    ? "requires_merge_split_resolution"
    : "ok";
  const state = buildTimelineState(events);
  const fullyExited = isFullyExited(state.shares);
  const capitalAtRisk = computeCapitalAtRisk(state);

  let resolutionPayoutUsd = 0;
  let completed = false;

  if (accountingStatus === "ok") {
    if (fullyExited && state.grossBuyCash > SHARE_BALANCE_EPSILON) {
      completed = true;
    } else if (
      resolution?.resolutionFinal &&
      state.grossBuyCash > SHARE_BALANCE_EPSILON
    ) {
      resolutionPayoutUsd =
        state.shares > SHARE_BALANCE_EPSILON
          ? settlementPayoutUsd(state, resolution, asset)
          : 0;
      completed = true;
    }
  }

  const realizedPnl = completed
    ? computeRealizedPnl(state, resolutionPayoutUsd)
    : null;

  return {
    state,
    fullyExited,
    capitalAtRisk,
    resolutionPayoutUsd,
    realizedPnl,
    completed,
  };
}
