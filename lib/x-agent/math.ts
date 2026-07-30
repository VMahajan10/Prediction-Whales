export interface ResolvedBet {
  payout: number;
  entryPrice: number;
}

/** AVG EV = (1/N) Σ (Payout − Entry) / Entry */
export function calculateAvgEv(resolvedBets: ResolvedBet[]): number {
  if (resolvedBets.length === 0) return 0;

  let sum = 0;
  let counted = 0;

  for (const bet of resolvedBets) {
    const entry = bet.entryPrice;
    if (!Number.isFinite(entry) || entry <= 0) continue;
    const payout = bet.payout;
    if (!Number.isFinite(payout)) continue;
    sum += (payout - entry) / entry;
    counted += 1;
  }

  if (counted === 0) return 0;
  return sum / counted;
}

import {
  selectEvGloss,
  type EvGloss,
} from "@/constants/evGlosses";

/** Pick a human-readable EV gloss for copy templates. */
export function formatEvGloss(
  avgEv: number,
  random: () => number = Math.random,
  options?: { excludeGloss?: string | null }
): EvGloss {
  void avgEv;
  return selectEvGloss({
    excludeGloss: options?.excludeGloss,
    random,
  });
}
