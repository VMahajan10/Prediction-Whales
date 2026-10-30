import type { MarketResolution } from "@/lib/backtest/types";
import type { GammaMarketResolution } from "@/lib/walletLedger/types";

export function gammaToMarketResolution(
  gamma: GammaMarketResolution
): MarketResolution {
  let resolvedAt: number | null = null;
  if (gamma.resolvedAt) {
    const ms = Date.parse(gamma.resolvedAt);
    if (Number.isFinite(ms)) resolvedAt = Math.floor(ms / 1000);
  }

  const outcomeByTokenId: Record<string, string> = {};
  for (let i = 0; i < gamma.clobTokenIds.length; i += 1) {
    const tokenId = gamma.clobTokenIds[i];
    if (!tokenId) continue;
    outcomeByTokenId[tokenId] = gamma.outcomes[i] ?? `outcome_${i}`;
  }

  return {
    conditionId: gamma.conditionId,
    marketTitle: gamma.question ?? null,
    outcomeByTokenId,
    winningAsset: gamma.winningAsset,
    resolvedAt,
    resolutionStatus: gamma.resolutionStatus,
    resolutionFinal: gamma.resolutionFinal,
  };
}

export function outcomeLabelForToken(
  resolution: MarketResolution,
  assetId: string
): string | null {
  if (!resolution.outcomeByTokenId) return null;
  const direct = resolution.outcomeByTokenId[assetId];
  if (direct) return direct;
  const lower = assetId.toLowerCase();
  for (const [token, label] of Object.entries(resolution.outcomeByTokenId)) {
    if (token.toLowerCase() === lower) return label;
  }
  return null;
}
