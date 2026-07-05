import {
  applyVenueStakeConstraints,
  optimizeEqualPayoutStakeSplit,
  type VenueStakeConstraints,
} from "@/lib/finance/arbitrageStakeMath";
import type { ArbStakePlan, ArbitrageWindow } from "@/lib/arbitrageFinder/types";

export interface AttachStakePlanOptions extends VenueStakeConstraints {
  totalStakeUsd: number;
}

export function buildStakePlan(
  window: ArbitrageWindow,
  options: AttachStakePlanOptions
): ArbStakePlan | null {
  if (!window.isActionable || window.legs.length < 2) return null;

  const [legA, legB] = window.legs;
  const split = optimizeEqualPayoutStakeSplit({
    legAAsk: legA.askPrice,
    legBAsk: legB.askPrice,
    totalStakeUsd: options.totalStakeUsd,
  });

  if (!split) return null;

  const adjusted = applyVenueStakeConstraints(split, options);

  return {
    totalStakeUsd: roundUsd(adjusted.legAStakeUsd + adjusted.legBStakeUsd),
    legStakesUsd: [adjusted.legAStakeUsd, adjusted.legBStakeUsd],
    guaranteedPayoutUsd: adjusted.guaranteedPayoutUsd,
    lockedProfitUsd: adjusted.lockedProfitUsd,
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export function attachStakePlan(
  window: ArbitrageWindow,
  options: AttachStakePlanOptions
): ArbitrageWindow {
  const stakePlan = buildStakePlan(window, options);
  if (!stakePlan) return window;
  return { ...window, stakePlan };
}

export function attachStakePlans(
  windows: ArbitrageWindow[],
  options: AttachStakePlanOptions
): ArbitrageWindow[] {
  return windows.map((window) => attachStakePlan(window, options));
}

export function attachStakeToBestWindow(
  windows: ArbitrageWindow[],
  options: AttachStakePlanOptions
): ArbitrageWindow | null {
  const actionable = windows.filter((w) => w.isActionable);
  if (actionable.length === 0) return null;

  const best = actionable.sort((a, b) => b.roiPercent - a.roiPercent)[0]!;
  return attachStakePlan(best, options);
}
