/**
 * Pure cross-venue binary box arbitrage math.
 * Independent of pTrue, computeTradeEvDisplay, and the EV pipeline.
 */

export const DEFAULT_MAX_COMBINED_COST = 1;

/** Alert when implied sum is strictly below 100%. */
export const DEFAULT_MAX_IMPLIED_SUM_PERCENT = 100;

export interface ArbLegInput {
  askPrice: number;
}

export type ArbRejectReason =
  | "missing_leg"
  | "invalid_price"
  | "sum_gte_threshold";

export interface ArbMathResult {
  combinedCost: number;
  impliedSumPercent: number;
  inverseOddsSumPercent: number;
  profitDeltaPerUnit: number;
  roiPercent: number;
  isActionable: boolean;
  rejectReason?: ArbRejectReason;
}

export interface EvaluateDirectionalWindowsResult {
  pmYesKalshiNo: ArbMathResult | null;
  kalshiYesPmNo: ArbMathResult | null;
}

export interface ArbEngineOptions {
  /** Actionable when combinedCost < this value (default 1.0). */
  maxCombinedCost?: number;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isValidAsk(price: number): boolean {
  return Number.isFinite(price) && price > 0 && price < 1;
}

function inactiveResult(
  rejectReason: ArbRejectReason
): ArbMathResult {
  return {
    combinedCost: 0,
    impliedSumPercent: 0,
    inverseOddsSumPercent: 0,
    profitDeltaPerUnit: 0,
    roiPercent: 0,
    isActionable: false,
    rejectReason,
  };
}

/**
 * Inverse decimal-odds sum % — equivalent to (yesAsk + noAsk) × 100 when
 * inputs are prediction-market probability costs.
 */
export function formatInverseOddsSumPercent(
  yesAsk: number,
  noAsk: number
): number {
  if (!isValidAsk(yesAsk) || !isValidAsk(noAsk)) return 0;
  const decimalYes = 1 / yesAsk;
  const decimalNo = 1 / noAsk;
  return round1((1 / decimalYes + 1 / decimalNo) * 100);
}

export function computeRoiPercent(combinedCost: number): number {
  if (!Number.isFinite(combinedCost) || combinedCost <= 0) return 0;
  const profit = 1 - combinedCost;
  return round1((profit / combinedCost) * 100);
}

/**
 * Evaluate a two-leg complementary box (YES on venue A, NO on venue B).
 * Canonical lock metric: combinedCost = askA + askB.
 */
export function evaluateBinaryBoxArbitrage(
  legA: ArbLegInput,
  legB: ArbLegInput,
  options: ArbEngineOptions = {}
): ArbMathResult {
  const maxCombinedCost = options.maxCombinedCost ?? DEFAULT_MAX_COMBINED_COST;
  const askA = legA.askPrice;
  const askB = legB.askPrice;

  if (!isValidAsk(askA) || !isValidAsk(askB)) {
    return inactiveResult("invalid_price");
  }

  const combinedCost = round4(askA + askB);
  const impliedSumPercent = round1(combinedCost * 100);
  const inverseOddsSumPercent = formatInverseOddsSumPercent(askA, askB);
  const profitDeltaPerUnit = round4(1 - combinedCost);
  const roiPercent = computeRoiPercent(combinedCost);

  if (combinedCost >= maxCombinedCost || profitDeltaPerUnit <= 0) {
    return {
      combinedCost,
      impliedSumPercent,
      inverseOddsSumPercent,
      profitDeltaPerUnit,
      roiPercent,
      isActionable: false,
      rejectReason: "sum_gte_threshold",
    };
  }

  return {
    combinedCost,
    impliedSumPercent,
    inverseOddsSumPercent,
    profitDeltaPerUnit,
    roiPercent,
    isActionable: true,
  };
}

/** Evaluate PM YES + Kalshi NO and Kalshi YES + PM NO concurrently. */
export function evaluateDirectionalWindows(
  pmYesAsk: number | null,
  pmNoAsk: number | null,
  kalshiYesAsk: number | null,
  kalshiNoAsk: number | null,
  options: ArbEngineOptions = {}
): EvaluateDirectionalWindowsResult {
  const pmYesKalshiNo =
    pmYesAsk != null && kalshiNoAsk != null
      ? evaluateBinaryBoxArbitrage(
          { askPrice: pmYesAsk },
          { askPrice: kalshiNoAsk },
          options
        )
      : null;

  const kalshiYesPmNo =
    kalshiYesAsk != null && pmNoAsk != null
      ? evaluateBinaryBoxArbitrage(
          { askPrice: kalshiYesAsk },
          { askPrice: pmNoAsk },
          options
        )
      : null;

  return { pmYesKalshiNo, kalshiYesPmNo };
}
