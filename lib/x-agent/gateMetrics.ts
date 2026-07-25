/** Minimum per-trade EV (display percent) to enter post-queue gate evaluation. */
export const HIGH_EV_TRADE_THRESHOLD_PCT = 3;

export interface GateSummary {
  totalEvaluated: number;
  failedEvThreshold: number;
  failedStakeFloor: number;
  failedCredibility: number;
  failedLegibilityOrAlignment: number;
  failedFreshness: number;
  failedKalshiSource: number;
  queuedSuccessfully: number;
}

export function createGateSummary(): GateSummary {
  return {
    totalEvaluated: 0,
    failedEvThreshold: 0,
    failedStakeFloor: 0,
    failedCredibility: 0,
    failedLegibilityOrAlignment: 0,
    failedFreshness: 0,
    failedKalshiSource: 0,
    queuedSuccessfully: 0,
  };
}

export function recordTradeEvaluated(metrics: GateSummary): void {
  metrics.totalEvaluated += 1;
}

export function recordEvThresholdFailure(metrics: GateSummary): void {
  metrics.failedEvThreshold += 1;
}

export function recordKalshiSourceFailure(metrics: GateSummary): void {
  metrics.failedKalshiSource += 1;
}

export function recordQueuedSuccess(metrics: GateSummary): void {
  metrics.queuedSuccessfully += 1;
}

const LEGIBILITY_OR_ALIGNMENT_REASONS = new Set([
  "ILLEGIBLE_MARKET",
  "LINE_DRIFT_EXCEEDED",
  "DUPLICATE_TRADE",
  "RECENT_MARKET_POST",
]);

const CREDIBILITY_REASONS = new Set(["BELOW_RESOLVED_BETS", "LOW_EV"]);

export function recordGateRejection(metrics: GateSummary, reason: string): void {
  if (reason === "KALSHI_SOURCE_REJECTED") {
    metrics.failedKalshiSource += 1;
    return;
  }
  if (reason === "BELOW_STAKE_FLOOR") {
    metrics.failedStakeFloor += 1;
    return;
  }
  if (CREDIBILITY_REASONS.has(reason)) {
    metrics.failedCredibility += 1;
    return;
  }
  if (reason === "STALE_TRADE") {
    metrics.failedFreshness += 1;
    return;
  }
  if (LEGIBILITY_OR_ALIGNMENT_REASONS.has(reason)) {
    metrics.failedLegibilityOrAlignment += 1;
  }
}

function padCount(value: number, width = 5): string {
  return String(value).padStart(width);
}

export function printGateSummaryBox(metrics: GateSummary): void {
  const lines = [
    "==================================================",
    "📊 SHADOW CRON RUN POST-QUEUE SUMMARY",
    "==================================================",
    `Total Trades Evaluated:      ${padCount(metrics.totalEvaluated)}`,
    `❌ Failed EV Threshold (<3%): ${padCount(metrics.failedEvThreshold)}`,
    `❌ Failed Stake Floor (<$25k): ${padCount(metrics.failedStakeFloor)}`,
    `❌ Failed Credibility (<3%):  ${padCount(metrics.failedCredibility)}`,
    `❌ Failed Alignment/Mapping:   ${padCount(metrics.failedLegibilityOrAlignment)}`,
    `❌ Failed Freshness (>10m):    ${padCount(metrics.failedFreshness)}`,
    `❌ Failed Kalshi Source:       ${padCount(metrics.failedKalshiSource)}`,
    "--------------------------------------------------",
    `✅ Queued to x_post_queue:     ${padCount(metrics.queuedSuccessfully)}`,
    "==================================================",
  ];

  console.log(lines.join("\n"));
}
