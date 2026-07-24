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

const EV_GLOSS_OPTIONS = [
  "profitable on average",
  "wins at the right price",
  "gets in at better prices than the market",
  "paid for disagreeing with the crowd",
  "makes money per bet, not just wins often",
] as const;

/** Pick a human-readable EV gloss for copy templates. */
export function formatEvGloss(
  avgEv: number,
  random = Math.random
): string {
  void avgEv;
  const index = Math.floor(random() * EV_GLOSS_OPTIONS.length);
  return EV_GLOSS_OPTIONS[index] ?? EV_GLOSS_OPTIONS[0];
}
