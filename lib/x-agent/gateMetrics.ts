/**
 * Canonical Shadow Cron post-queue gate thresholds and summary metrics.
 *
 * Evaluation logic consumes these constants from `lib/x-agent/gates.ts`.
 * `scripts/run-shadow-cron.ts` prints the matrix via `printGateSummaryBox()`.
 */

import {
  formatStakeFloorSummaryLabel,
  STAKE_FLOOR_DEFAULT_USD,
} from "@/lib/x-agent/stakeFloor";

/** Minimum live trade EV as display percent (+2.5%). */
export const HIGH_EV_TRADE_THRESHOLD_PCT = 2.5;

/** Minimum live trade EV as decimal (trade.ev >= 0.025). */
export const MIN_TRADE_EV_DECIMAL = 0.025;

/** Minimum wallet historical avg EV from registry (wallet.avgEv >= 0.025). */
export const MIN_WALLET_AVG_EV_DECIMAL = 0.025;

/** Minimum wallet historical avg EV as display percent (+2.5%). */
export const MIN_WALLET_AVG_EV_THRESHOLD_PCT =
  MIN_WALLET_AVG_EV_DECIMAL * 100;

/** Minimum resolved bets on wallet registry for credibility (default 300). */
export const MIN_WALLET_RESOLVED_BETS = (() => {
  const parsed = Number(process.env.RESOLVED_BETS_FLOOR);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300;
})();

/** Alias used by post-generation filters — same floor as wallet credibility. */
export const MIN_RESOLVED_THRESHOLD = MIN_WALLET_RESOLVED_BETS;

export function meetsResolvedBetsThreshold(
  resolvedCount: number | null | undefined
): boolean {
  return (
    resolvedCount != null &&
    Number.isFinite(resolvedCount) &&
    resolvedCount >= MIN_RESOLVED_THRESHOLD
  );
}

/** Legacy default stake floor (tiered floors use stakeFloor.ts). */
export const STAKE_FLOOR_USD = STAKE_FLOOR_DEFAULT_USD;

export interface GateSummary {
  totalEvaluated: number;
  failedEvThreshold: number;
  failedStakeFloor: number;
  failedCredibility: number;
  failedCredibility_ResolvedBets: number;
  failedCredibility_AvgEv: number;
  failedCredibility_NotInRegistry: number;
  failedLegibilityOrAlignment: number;
  failedFreshness: number;
  failedKalshiSource: number;
  queuedSuccessfully: number;
}

export interface GateMatrixCounters {
  passesEv: boolean;
  passesStake: boolean;
  passesCredibility: boolean;
  passesAlignment: boolean;
  passesFreshness: boolean;
  passesSource: boolean;
}

export function createGateSummary(): GateSummary {
  return {
    totalEvaluated: 0,
    failedEvThreshold: 0,
    failedStakeFloor: 0,
    failedCredibility: 0,
    failedCredibility_ResolvedBets: 0,
    failedCredibility_AvgEv: 0,
    failedCredibility_NotInRegistry: 0,
    failedLegibilityOrAlignment: 0,
    failedFreshness: 0,
    failedKalshiSource: 0,
    queuedSuccessfully: 0,
  };
}

export function recordTradeEvaluated(metrics: GateSummary): void {
  metrics.totalEvaluated += 1;
}

export interface CredibilityGateWhale {
  resolvedBetsCount: number;
  avgEv: number;
}

export function recordCredibilityFailureBreakdown(
  metrics: GateSummary,
  whale?: CredibilityGateWhale | null
): void {
  metrics.failedCredibility += 1;

  if (!whale) {
    metrics.failedCredibility_NotInRegistry += 1;
    return;
  }

  if (whale.resolvedBetsCount < MIN_WALLET_RESOLVED_BETS) {
    metrics.failedCredibility_ResolvedBets += 1;
  }
  if (whale.avgEv < MIN_WALLET_AVG_EV_DECIMAL) {
    metrics.failedCredibility_AvgEv += 1;
  }
}

export function recordGateMatrixFailures(
  metrics: GateSummary,
  matrix: GateMatrixCounters,
  whale?: CredibilityGateWhale | null
): void {
  if (!matrix.passesEv) metrics.failedEvThreshold += 1;
  if (!matrix.passesStake) metrics.failedStakeFloor += 1;
  if (!matrix.passesCredibility) {
    recordCredibilityFailureBreakdown(metrics, whale);
  }
  if (!matrix.passesAlignment) metrics.failedLegibilityOrAlignment += 1;
  if (!matrix.passesFreshness) metrics.failedFreshness += 1;
  if (!matrix.passesSource) metrics.failedKalshiSource += 1;
}

/** Record a single pre-EV gate failure after short-circuit evaluation. */
export function recordPreGateFailure(
  metrics: GateSummary,
  reason:
    | "KALSHI_SOURCE_REJECTED"
    | "STALE_TRADE"
    | "BELOW_STAKE_FLOOR"
    | "ILLEGIBLE_MARKET"
    | "BELOW_TRADE_EV"
    | "BELOW_RESOLVED_BETS"
    | "LOW_EV",
  whale?: CredibilityGateWhale | null
): void {
  switch (reason) {
    case "KALSHI_SOURCE_REJECTED":
      metrics.failedKalshiSource += 1;
      break;
    case "STALE_TRADE":
      metrics.failedFreshness += 1;
      break;
    case "BELOW_STAKE_FLOOR":
      metrics.failedStakeFloor += 1;
      break;
    case "ILLEGIBLE_MARKET":
      metrics.failedLegibilityOrAlignment += 1;
      break;
    case "BELOW_TRADE_EV":
      metrics.failedEvThreshold += 1;
      break;
    case "BELOW_RESOLVED_BETS":
    case "LOW_EV":
      recordCredibilityFailureBreakdown(metrics, whale);
      break;
    default:
      break;
  }
}

export function recordQueuedSuccess(metrics: GateSummary): void {
  metrics.queuedSuccessfully += 1;
}

/** Collects per-trade gate-matrix metrics for rolling-window aggregation. */
export interface GateMetricsCollector {
  recordTradeEvaluated(): void;
  recordGateMatrixFailures(
    matrix: GateMatrixCounters,
    whale?: CredibilityGateWhale | null
  ): void;
  recordPreGateFailure(
    reason:
      | "KALSHI_SOURCE_REJECTED"
      | "STALE_TRADE"
      | "BELOW_STAKE_FLOOR"
      | "ILLEGIBLE_MARKET"
      | "BELOW_TRADE_EV"
      | "BELOW_RESOLVED_BETS"
      | "LOW_EV",
    whale?: CredibilityGateWhale | null
  ): void;
  recordQueuedSuccess(): void;
  finalizeTrade(): void;
}

export function createGateSummaryCollector(
  summary: GateSummary
): GateMetricsCollector {
  return {
    recordTradeEvaluated: () => recordTradeEvaluated(summary),
    recordGateMatrixFailures: (matrix, whale) =>
      recordGateMatrixFailures(summary, matrix, whale),
    recordPreGateFailure: (reason, whale) =>
      recordPreGateFailure(summary, reason, whale),
    recordQueuedSuccess: () => recordQueuedSuccess(summary),
    finalizeTrade: () => {},
  };
}

function mergeGateSummary(target: GateSummary, source: GateSummary): void {
  target.totalEvaluated += source.totalEvaluated;
  target.failedEvThreshold += source.failedEvThreshold;
  target.failedStakeFloor += source.failedStakeFloor;
  target.failedCredibility += source.failedCredibility;
  target.failedCredibility_ResolvedBets +=
    source.failedCredibility_ResolvedBets;
  target.failedCredibility_AvgEv += source.failedCredibility_AvgEv;
  target.failedCredibility_NotInRegistry +=
    source.failedCredibility_NotInRegistry;
  target.failedLegibilityOrAlignment += source.failedLegibilityOrAlignment;
  target.failedFreshness += source.failedFreshness;
  target.failedKalshiSource += source.failedKalshiSource;
  target.queuedSuccessfully += source.queuedSuccessfully;
}

export class RollingGateMatrixTracker implements GateMetricsCollector {
  private readonly ring: GateSummary[] = [];
  private tradeMetrics: GateSummary | null = null;

  constructor(private readonly maxSize = 1000) {}

  recordTradeEvaluated(): void {
    recordTradeEvaluated(this.active());
  }

  recordGateMatrixFailures(
    matrix: GateMatrixCounters,
    whale?: CredibilityGateWhale | null
  ): void {
    recordGateMatrixFailures(this.active(), matrix, whale);
  }

  recordPreGateFailure(
    reason:
      | "KALSHI_SOURCE_REJECTED"
      | "STALE_TRADE"
      | "BELOW_STAKE_FLOOR"
      | "ILLEGIBLE_MARKET"
      | "BELOW_TRADE_EV"
      | "BELOW_RESOLVED_BETS"
      | "LOW_EV",
    whale?: CredibilityGateWhale | null
  ): void {
    recordPreGateFailure(this.active(), reason, whale);
  }

  recordQueuedSuccess(): void {
    recordQueuedSuccess(this.active());
  }

  finalizeTrade(): void {
    if (!this.tradeMetrics) return;
    this.ring.push(this.tradeMetrics);
    if (this.ring.length > this.maxSize) {
      this.ring.shift();
    }
    this.tradeMetrics = null;
  }

  aggregate(): GateSummary {
    const total = createGateSummary();
    for (const entry of this.ring) {
      mergeGateSummary(total, entry);
    }
    if (this.tradeMetrics) {
      mergeGateSummary(total, this.tradeMetrics);
    }
    return total;
  }

  getWindowSize(): number {
    return this.ring.length + (this.tradeMetrics ? 1 : 0);
  }

  private active(): GateSummary {
    if (!this.tradeMetrics) {
      this.tradeMetrics = createGateSummary();
    }
    return this.tradeMetrics;
  }
}

export function resolveGateMetricsCollector(
  metrics?: GateSummary | GateMetricsCollector
): GateMetricsCollector | undefined {
  if (!metrics) return undefined;
  if (
    typeof metrics === "object" &&
    "finalizeTrade" in metrics &&
    typeof metrics.finalizeTrade === "function"
  ) {
    return metrics as GateMetricsCollector;
  }
  return createGateSummaryCollector(metrics as GateSummary);
}

function formatGateFraction(count: number, total: number, width = 5): string {
  const countStr = String(count).padStart(width);
  const totalStr = String(total).padStart(width);
  return `${countStr} / ${totalStr}`;
}

function formatStakeFloorSummaryLabelForBox(): string {
  return formatStakeFloorSummaryLabel();
}

export function printGateSummaryBox(
  metrics: GateSummary,
  options?: { rollingWindow?: number }
): void {
  const total = metrics.totalEvaluated;
  const stakeFloorSummaryLabel = formatStakeFloorSummaryLabelForBox();
  const tradeEvLabel = `+${HIGH_EV_TRADE_THRESHOLD_PCT}%`;
  const walletEvLabel = `+${MIN_WALLET_AVG_EV_THRESHOLD_PCT}%`;
  const rollingLabel =
    options?.rollingWindow != null
      ? ` (rolling last ${options.rollingWindow})`
      : "";
  const lines = [
    "==================================================",
    `📊 SHADOW CRON FULL GATE-MATRIX SUMMARY${rollingLabel}`,
    "==================================================",
    `Total Trades Evaluated:        ${String(total).padStart(5)}`,
    `❌ Failed Trade EV (<${tradeEvLabel}):        ${formatGateFraction(metrics.failedEvThreshold, total)}`,
    `❌ Failed Stake Floor (${stakeFloorSummaryLabel}):   ${formatGateFraction(metrics.failedStakeFloor, total)}`,
    `❌ Failed Wallet Credibility:    ${formatGateFraction(metrics.failedCredibility, total)}`,
    `   ❌ Failed Credibility (Missing in DB)   ${formatGateFraction(metrics.failedCredibility_NotInRegistry, total)}`,
    `   ❌ Failed Credibility (Bets < ${MIN_WALLET_RESOLVED_BETS}):      ${formatGateFraction(metrics.failedCredibility_ResolvedBets, total)}`,
    `   ❌ Failed Credibility (AVG EV < ${walletEvLabel}):   ${formatGateFraction(metrics.failedCredibility_AvgEv, total)}`,
    `❌ Failed Alignment/Mapping:      ${formatGateFraction(metrics.failedLegibilityOrAlignment, total)}`,
    `❌ Failed Freshness (>10m):       ${formatGateFraction(metrics.failedFreshness, total)}`,
    `❌ Failed Kalshi Source:          ${formatGateFraction(metrics.failedKalshiSource, total)}`,
    "--------------------------------------------------",
    `✅ Passed ALL Gates (Queued):     ${formatGateFraction(metrics.queuedSuccessfully, total)}`,
    "==================================================",
  ];

  console.log(lines.join("\n"));
}
