/**
 * Equal-payout stake split for two-leg binary box arbitrage.
 * Pure math — no I/O, no EV pipeline coupling.
 */

export interface StakeSplitInput {
  legAAsk: number;
  legBAsk: number;
  totalStakeUsd: number;
}

export interface StakeSplitResult {
  legAStakeUsd: number;
  legBStakeUsd: number;
  unitsPerLeg: number;
  guaranteedPayoutUsd: number;
  lockedProfitUsd: number;
  lockedRoiPercent: number;
}

export interface VenueStakeConstraints {
  pmMinUsd?: number;
  kalshiMinUsd?: number;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isValidAsk(price: number): boolean {
  return Number.isFinite(price) && price > 0 && price < 1;
}

/**
 * Split total stake S across two complementary legs so payout is identical
 * regardless of which outcome wins.
 *
 * n = S / (p1 + p2)
 * S1 = n * p1, S2 = n * p2
 * Payout = n = S / (p1 + p2)
 */
export function optimizeEqualPayoutStakeSplit(
  input: StakeSplitInput
): StakeSplitResult | null {
  const { legAAsk, legBAsk, totalStakeUsd } = input;

  if (
    !isValidAsk(legAAsk) ||
    !isValidAsk(legBAsk) ||
    !Number.isFinite(totalStakeUsd) ||
    totalStakeUsd <= 0
  ) {
    return null;
  }

  const combinedCost = legAAsk + legBAsk;
  if (combinedCost <= 0 || combinedCost >= 1) return null;

  const unitsPerLeg = totalStakeUsd / combinedCost;
  const legAStakeUsd = roundUsd(unitsPerLeg * legAAsk);
  const legBStakeUsd = roundUsd(unitsPerLeg * legBAsk);
  const guaranteedPayoutUsd = roundUsd(unitsPerLeg);
  const lockedProfitUsd = roundUsd(guaranteedPayoutUsd - totalStakeUsd);
  const lockedRoiPercent = round1((lockedProfitUsd / totalStakeUsd) * 100);

  return {
    legAStakeUsd,
    legBStakeUsd,
    unitsPerLeg: roundUsd(unitsPerLeg),
    guaranteedPayoutUsd,
    lockedProfitUsd,
    lockedRoiPercent,
  };
}

/** Apply minimum stake floors per venue (best-effort). */
export function applyVenueStakeConstraints(
  split: StakeSplitResult,
  constraints: VenueStakeConstraints = {}
): StakeSplitResult {
  const pmMin = constraints.pmMinUsd ?? 0;
  const kalshiMin = constraints.kalshiMinUsd ?? 0;
  const minFloor = Math.max(pmMin, kalshiMin, 0);

  if (minFloor <= 0) return split;
  if (split.legAStakeUsd >= minFloor && split.legBStakeUsd >= minFloor) {
    return split;
  }

  const scale =
    minFloor /
    Math.min(
      split.legAStakeUsd > 0 ? split.legAStakeUsd : minFloor,
      split.legBStakeUsd > 0 ? split.legBStakeUsd : minFloor
    );

  if (!Number.isFinite(scale) || scale <= 1) return split;

  const legAStakeUsd = roundUsd(split.legAStakeUsd * scale);
  const legBStakeUsd = roundUsd(split.legBStakeUsd * scale);
  const totalStakeUsd = roundUsd(legAStakeUsd + legBStakeUsd);
  const unitsPerLeg = split.unitsPerLeg * scale;
  const guaranteedPayoutUsd = roundUsd(unitsPerLeg);
  const lockedProfitUsd = roundUsd(guaranteedPayoutUsd - totalStakeUsd);

  return {
    legAStakeUsd,
    legBStakeUsd,
    unitsPerLeg: roundUsd(unitsPerLeg),
    guaranteedPayoutUsd,
    lockedProfitUsd,
    lockedRoiPercent: round1((lockedProfitUsd / totalStakeUsd) * 100),
  };
}
