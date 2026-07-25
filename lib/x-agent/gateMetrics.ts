/** Minimum live trade EV as display percent (+3%). */
export const HIGH_EV_TRADE_THRESHOLD_PCT = 3;

/** Minimum live trade EV as decimal (trade.ev >= 0.03). */
export const MIN_TRADE_EV_DECIMAL = 0.03;

/** Minimum wallet historical avg EV from registry (wallet.avgEv >= 0.025). */
export const MIN_WALLET_AVG_EV_DECIMAL = 0.025;

/** Minimum wallet historical avg EV as display percent (+2.5%). */
export const MIN_WALLET_AVG_EV_THRESHOLD_PCT =
  MIN_WALLET_AVG_EV_DECIMAL * 100;

/** Minimum resolved bets on wallet registry for credibility. */
export const MIN_WALLET_RESOLVED_BETS = 100;

/** Minimum trade stake notional (USD) for post-queue gates. */
export const STAKE_FLOOR_USD = (() => {
  const parsed = Number(process.env.STAKE_FLOOR_USD);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
})();

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

export function recordQueuedSuccess(metrics: GateSummary): void {
  metrics.queuedSuccessfully += 1;
}

function formatGateFraction(count: number, total: number, width = 5): string {
  const countStr = String(count).padStart(width);
  const totalStr = String(total).padStart(width);
  return `${countStr} / ${totalStr}`;
}

function formatStakeFloorLabel(usd: number): string {
  if (usd >= 1000 && usd % 1000 === 0) return `$${usd / 1000}k`;
  return `$${usd.toLocaleString("en-US")}`;
}

export function printGateSummaryBox(metrics: GateSummary): void {
  const total = metrics.totalEvaluated;
  const stakeFloorLabel = formatStakeFloorLabel(STAKE_FLOOR_USD);
  const walletEvLabel = `+${MIN_WALLET_AVG_EV_THRESHOLD_PCT}%`;
  const lines = [
    "==================================================",
    "📊 SHADOW CRON FULL GATE-MATRIX SUMMARY",
    "==================================================",
    `Total Trades Evaluated:        ${String(total).padStart(5)}`,
    `❌ Failed Trade EV (<3%):        ${formatGateFraction(metrics.failedEvThreshold, total)}`,
    `❌ Failed Stake Floor (<${stakeFloorLabel}):   ${formatGateFraction(metrics.failedStakeFloor, total)}`,
    `❌ Failed Wallet Credibility:    ${formatGateFraction(metrics.failedCredibility, total)}`,
    `   ❌ Failed Credibility (Missing in DB)   ${formatGateFraction(metrics.failedCredibility_NotInRegistry, total)}`,
    `   ❌ Failed Credibility (Bets < ${MIN_WALLET_RESOLVED_BETS})      ${formatGateFraction(metrics.failedCredibility_ResolvedBets, total)}`,
    `   ❌ Failed Credibility (AVG EV < ${walletEvLabel})   ${formatGateFraction(metrics.failedCredibility_AvgEv, total)}`,
    `❌ Failed Alignment/Mapping:      ${formatGateFraction(metrics.failedLegibilityOrAlignment, total)}`,
    `❌ Failed Freshness (>10m):       ${formatGateFraction(metrics.failedFreshness, total)}`,
    `❌ Failed Kalshi Source:          ${formatGateFraction(metrics.failedKalshiSource, total)}`,
    "--------------------------------------------------",
    `✅ Passed ALL Gates (Queued):     ${formatGateFraction(metrics.queuedSuccessfully, total)}`,
    "==================================================",
  ];

  console.log(lines.join("\n"));
}
