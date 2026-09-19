import { SHARE_BALANCE_EPSILON } from "@/lib/walletLedger/constants";
import { sortLedgerEventsCanonical } from "@/lib/walletLedger/eventOrder";
import { GammaResolutionCache, isWinningAsset } from "@/lib/walletLedger/gamma";
import { positionKey } from "@/lib/walletLedger/normalize";
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
    case "MERGE":
    case "SPLIT":
      break;
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

  const resolution = conditionId
    ? (gammaCache.get(conditionId) ??
      (await gammaCache.resolve(conditionId, {
        slugs: slug ? [slug] : [],
        assets: asset ? [asset] : [],
      })))
    : null;

  let resolutionPayoutUsd = 0;
  let heldThroughResolution = false;
  let completed = false;
  let completionReason: PositionLifecycle["completionReason"] = null;

  if (accountingStatus === "ok") {
    if (fullyExited && state.grossBuyCash > 0) {
      completed = true;
      completionReason = "fully_exited";
    } else if (
      !fullyExited &&
      state.shares > SHARE_BALANCE_EPSILON &&
      resolution?.resolutionFinal
    ) {
      heldThroughResolution = true;
      resolutionPayoutUsd = settlementPayoutUsd(state, resolution, asset);
      completed = true;
      completionReason = "held_through_resolution";
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
  } else if (
    heldThroughResolution &&
    resolution &&
    !resolution.resolutionFinal
  ) {
    excludedFromMetrics = true;
    exclusionReason = "gamma_resolution_missing";
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
    if (!event.conditionId && !event.asset) continue;
    const key = positionKey(event);
    const list = grouped.get(key) ?? [];
    list.push(event);
    grouped.set(key, list);
  }

  const positions: PositionLifecycle[] = [];
  const sortedKeys = [...grouped.keys()].sort();

  for (const key of sortedKeys) {
    const positionEvents = grouped.get(key)!;
    const [conditionId, asset] = key.split("::");
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
    if (fullyExited && state.grossBuyCash > 0) {
      completed = true;
    } else if (
      !fullyExited &&
      state.shares > SHARE_BALANCE_EPSILON &&
      resolution?.resolutionFinal
    ) {
      resolutionPayoutUsd = settlementPayoutUsd(state, resolution, asset);
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
