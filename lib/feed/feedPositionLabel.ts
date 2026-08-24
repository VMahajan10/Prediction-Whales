import type { WhaleTrade } from "@/lib/whaleTrades";

const RAW_DIRECTIONAL_RE =
  /^(?:backing|bought|sold)\s+(?:yes|no)\.?$/i;

/**
 * User-facing direction copy for whale feed cards.
 * Never derives labels from raw Yes/No outcome tokens.
 */
export function resolveWhaleFeedPositionLabel(
  trade: WhaleTrade
): string | null {
  if (trade.source === "kalshi" && trade.selectionLabel?.trim()) {
    return trade.selectionLabel.trim();
  }

  const exitLabel = trade.marketTranslation?.exitByLabel?.trim();
  if (exitLabel) return exitLabel;

  const backingLabel = trade.marketTranslation?.backingLabel?.trim();
  if (!backingLabel || RAW_DIRECTIONAL_RE.test(backingLabel)) {
    return null;
  }

  return backingLabel;
}
