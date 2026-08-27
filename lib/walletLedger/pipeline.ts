import {
  fetchActivityHistory,
  fetchPositionsSnapshot,
  fetchTradeHistory,
} from "@/lib/walletLedger/fetchers";
import {
  buildMarketResolveHints,
  GammaResolutionCache,
} from "@/lib/walletLedger/gamma";
import { resolvePolymarketHistoryIdentity } from "@/lib/walletLedger/identity";
import type { ResolvePolymarketHistoryIdentityInput } from "@/lib/walletLedger/identity";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import {
  deduplicateLedgerEvents,
  normalizeActivityRows,
  normalizeTradeRows,
} from "@/lib/walletLedger/normalize";
import type {
  ProductionWalletMetrics,
  WalletLedgerAuditResult,
} from "@/lib/walletLedger/types";

export interface RunWalletLedgerAuditInput {
  label: string;
  wallet: string;
  transactionHash?: string;
  assetId?: string;
  production?: ProductionWalletMetrics | null;
  identity?: ResolvePolymarketHistoryIdentityInput["probe"];
  interPageDelayMs?: number;
}

function buildEmptyAuditResult(
  input: RunWalletLedgerAuditInput,
  identity: Awaited<ReturnType<typeof resolvePolymarketHistoryIdentity>>
): WalletLedgerAuditResult {
  const emptyMetrics = computeWalletLedgerMetrics({
    positions: [],
    identity,
    activityTruncated: false,
    tradesTruncated: false,
    rawEventCount: 0,
    deduplicatedEventCount: 0,
    gammaCoverage: {
      distinctMarkets: 0,
      marketsFoundBefore: 0,
      marketsFoundAfter: 0,
      resolvedBefore: 0,
      resolvedAfter: 0,
      coverageBeforePct: 1,
      coverageAfterPct: 1,
      marketFoundCoverageAfterPct: 1,
    },
    mergeSplit: analyzeMergeSplitImpact([]),
    hasHistoryEvents: false,
  });

  return {
    label: input.label,
    identity,
    activity: {
      rows: [],
      truncated: false,
      pagesFetched: 0,
      maxOffsetReached: 0,
      pageSize: 0,
    },
    trades: {
      rows: [],
      truncated: false,
      pagesFetched: 0,
      maxOffsetReached: 0,
      pageSize: 0,
    },
    positionsCount: identity.positionsCount,
    gammaResolvedCount: 0,
    gammaTotalMarkets: 0,
    positions: [],
    metrics: emptyMetrics,
    production: input.production ?? null,
    reconciliation: {
      rawEvents: 0,
      deduplicatedEvents: 0,
      distinctPositions: 0,
      completedPositions: 0,
      openPositions: 0,
      excludedPositions: 0,
      fullyExitedPositions: 0,
      heldThroughResolutionPositions: 0,
      winningHeldPositions: 0,
      losingHeldPositions: 0,
      unresolvedHeldPositions: 0,
    },
  };
}

export async function runWalletLedgerAudit(
  input: RunWalletLedgerAuditInput
): Promise<WalletLedgerAuditResult> {
  const identity = await resolvePolymarketHistoryIdentity({
    wallet: input.wallet,
    transactionHash: input.transactionHash,
    assetId: input.assetId,
    probe: input.identity,
  });

  if (!identity.historyWallet) {
    return buildEmptyAuditResult(input, identity);
  }

  const historyWallet = identity.historyWallet;
  const fetchOptions = { interPageDelayMs: input.interPageDelayMs ?? 0 };

  const [activity, trades, positionsSnapshot] = await Promise.all([
    fetchActivityHistory(historyWallet, fetchOptions),
    fetchTradeHistory(historyWallet, fetchOptions),
    fetchPositionsSnapshot(historyWallet),
  ]);

  const activityEvents = normalizeActivityRows(activity.rows, historyWallet);
  const tradeEvents = normalizeTradeRows(trades.rows, historyWallet);
  const deduplicatedEvents = deduplicateLedgerEvents(
    activityEvents,
    tradeEvents
  );

  const gammaCache = new GammaResolutionCache();
  const hints = buildMarketResolveHints(deduplicatedEvents);
  const prefetchStats = await gammaCache.prefetch(hints);

  const { positions } = await buildPositionLifecycles(
    historyWallet,
    deduplicatedEvents,
    gammaCache
  );

  const conditionIds = new Set(
    positions.map((p) => p.conditionId).filter(Boolean)
  );
  const gammaResolvedCount = gammaCache.countResolved();

  const mergeSplit = analyzeMergeSplitImpact(positions);
  const gammaCoverage = {
    distinctMarkets: conditionIds.size,
    marketsFoundBefore: prefetchStats.marketsFoundBefore,
    marketsFoundAfter: prefetchStats.marketsFoundAfter,
    resolvedBefore: prefetchStats.resolvedBefore,
    resolvedAfter: prefetchStats.resolvedAfter,
    coverageBeforePct:
      conditionIds.size > 0
        ? prefetchStats.resolvedBefore / conditionIds.size
        : 1,
    coverageAfterPct:
      conditionIds.size > 0
        ? prefetchStats.resolvedAfter / conditionIds.size
        : 1,
    marketFoundCoverageAfterPct:
      conditionIds.size > 0
        ? prefetchStats.marketsFoundAfter / conditionIds.size
        : 1,
  };

  const metrics = computeWalletLedgerMetrics({
    positions,
    identity,
    activityTruncated: activity.truncated,
    tradesTruncated: trades.truncated,
    rawEventCount: activityEvents.length + tradeEvents.length,
    deduplicatedEventCount: deduplicatedEvents.length,
    gammaCoverage,
    mergeSplit,
    hasHistoryEvents: deduplicatedEvents.length > 0,
  });

  const completedPositions = positions.filter((p) => p.completed);
  const openPositions = positions.filter((p) => !p.completed);
  const excludedPositions = positions.filter((p) => p.excludedFromMetrics);
  const heldThrough = positions.filter((p) => p.heldThroughResolution);
  const winningHeld = heldThrough.filter((p) => p.outcomeCorrect === true);
  const losingHeld = heldThrough.filter((p) => p.outcomeCorrect === false);
  const unresolvedHeld = heldThrough.filter(
    (p) => !p.resolution?.resolutionFinal
  );

  return {
    label: input.label,
    identity,
    activity,
    trades,
    positionsCount: positionsSnapshot.length,
    gammaResolvedCount,
    gammaTotalMarkets: conditionIds.size,
    positions,
    metrics,
    production: input.production ?? null,
    reconciliation: {
      rawEvents: activityEvents.length + tradeEvents.length,
      deduplicatedEvents: deduplicatedEvents.length,
      distinctPositions: positions.length,
      completedPositions: completedPositions.length,
      openPositions: openPositions.length,
      excludedPositions: excludedPositions.length,
      fullyExitedPositions: positions.filter((p) => p.fullyExited).length,
      heldThroughResolutionPositions: heldThrough.length,
      winningHeldPositions: winningHeld.length,
      losingHeldPositions: losingHeld.length,
      unresolvedHeldPositions: unresolvedHeld.length,
    },
  };
}
