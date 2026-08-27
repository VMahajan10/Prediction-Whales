import type { PositionLifecycle } from "@/lib/walletLedger/types";

export interface MergeSplitImpactReport {
  positionsWithMergeSplit: number;
  pctCompletedPositionsAffected: number;
  grossCashAffected: number;
  potentialCapitalAtRiskAffected: number;
  safeDespiteMergeSplit: number;
  ambiguousMergeSplit: number;
  pctAmbiguousOfCompleted: number;
  recommendation: "exclude_policy_sufficient" | "phase_2c_accounting_required";
}

function hasMergeOrSplitEvents(position: PositionLifecycle): boolean {
  return position.events.some(
    (e) => e.type === "MERGE" || e.type === "SPLIT"
  );
}

/**
 * Positions with MERGE/SPLIT where BUY/SELL/REDEEM cash flows still net to
 * zero shares — PnL may be computable without modeling merge/split semantics.
 */
function isSafeDespiteMergeSplit(position: PositionLifecycle): boolean {
  if (!hasMergeOrSplitEvents(position)) return false;
  return (
    position.fullyExited &&
    position.accountingStatus === "requires_merge_split_resolution" &&
    position.grossBuyCash > 0
  );
}

function isAmbiguousMergeSplit(position: PositionLifecycle): boolean {
  if (!hasMergeOrSplitEvents(position)) return false;
  return !isSafeDespiteMergeSplit(position);
}

export function analyzeMergeSplitImpact(
  positions: PositionLifecycle[]
): MergeSplitImpactReport {
  const withMergeSplit = positions.filter(hasMergeOrSplitEvents);
  const completed = positions.filter((p) => p.completed);
  const completedWithMergeSplit = withMergeSplit.filter((p) => p.completed);
  const safe = withMergeSplit.filter(isSafeDespiteMergeSplit);
  const ambiguous = withMergeSplit.filter(isAmbiguousMergeSplit);

  const grossCashAffected = withMergeSplit.reduce(
    (sum, p) => sum + p.grossBuyCash + p.grossSellCash + p.redeemCash,
    0
  );
  const potentialCapitalAtRiskAffected = withMergeSplit.reduce(
    (sum, p) => sum + p.capitalAtRisk,
    0
  );

  const pctCompletedPositionsAffected =
    completed.length > 0
      ? completedWithMergeSplit.length / completed.length
      : 0;
  const pctAmbiguousOfCompleted =
    completed.length > 0 ? ambiguous.filter((p) => p.completed).length / completed.length : 0;

  const recommendation =
    pctAmbiguousOfCompleted < 0.05
      ? "exclude_policy_sufficient"
      : "phase_2c_accounting_required";

  return {
    positionsWithMergeSplit: withMergeSplit.length,
    pctCompletedPositionsAffected,
    grossCashAffected,
    potentialCapitalAtRiskAffected,
    safeDespiteMergeSplit: safe.length,
    ambiguousMergeSplit: ambiguous.length,
    pctAmbiguousOfCompleted,
    recommendation,
  };
}
