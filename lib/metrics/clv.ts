export interface ClvWalletFallback {
  roi?: number | null;
  avgEv?: number | null;
}

export interface CalculateClvInput {
  entryPrice: number;
  closingPrice: number;
}

export interface ResolveClvScoreInput {
  entryPrice: number;
  closingPrice?: number | null;
  wallet?: ClvWalletFallback | null;
}

/** Normalize wallet metrics that may be stored as decimals or display percents. */
function normalizeWalletMetric(value: number): number {
  if (Math.abs(value) <= 1) return value;
  return value / 100;
}

/**
 * Closing Line Value — relative edge vs. the market's last consensus price.
 * Returns decimal ratio, e.g. 0.05 = +5% vs. entry.
 */
export function calculateCLV({
  entryPrice,
  closingPrice,
}: CalculateClvInput): number | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!Number.isFinite(closingPrice)) return null;
  return (closingPrice - entryPrice) / entryPrice;
}

/** Wallet-level CLV proxy when no closing line is available. */
export function resolveWalletClvScore(
  wallet: ClvWalletFallback | null | undefined
): number | null {
  if (!wallet) return null;

  if (wallet.roi != null && Number.isFinite(wallet.roi)) {
    return normalizeWalletMetric(wallet.roi);
  }
  if (wallet.avgEv != null && Number.isFinite(wallet.avgEv)) {
    return normalizeWalletMetric(wallet.avgEv);
  }

  return null;
}

/**
 * Resolve a CLV score from trade prices when possible; otherwise fall back to
 * wallet ROI, then wallet average EV.
 */
export function resolveClvScore({
  entryPrice,
  closingPrice,
  wallet,
}: ResolveClvScoreInput): number | null {
  if (closingPrice != null && Number.isFinite(closingPrice)) {
    const clv = calculateCLV({ entryPrice, closingPrice });
    if (clv != null) return clv;
  }

  return resolveWalletClvScore(wallet);
}
