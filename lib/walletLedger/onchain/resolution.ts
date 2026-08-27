import { GammaResolutionCache } from "@/lib/walletLedger/gamma";
import type { GammaMarketResolution } from "@/lib/walletLedger/types";
import { TOPIC_CONDITION_RESOLUTION } from "@/lib/walletLedger/onchain/contracts";
import { decodeConditionResolution } from "@/lib/walletLedger/onchain/decode";
import type { ParsedConditionResolution } from "@/lib/walletLedger/onchain/types";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

export interface OnChainResolutionEntry {
  conditionId: string;
  resolution: GammaMarketResolution;
  source: "onchain";
  blockNumber: number;
  transactionHash: string;
}

export function conditionResolutionToGamma(
  event: ParsedConditionResolution
): GammaMarketResolution {
  const numerators = event.payoutNumerators.map((n) => Number(n));
  const denominator = numerators.reduce((sum, n) => sum + n, 0);
  const outcomePrices =
    denominator > 0
      ? numerators.map((n) => n / denominator)
      : numerators.map(() => 0);
  let winningIndex: number | null = null;
  for (let i = 0; i < outcomePrices.length; i += 1) {
    if (outcomePrices[i] >= 0.95) {
      winningIndex = i;
      break;
    }
  }
  const resolutionFinal =
    denominator > 0 && winningIndex != null && outcomePrices.length >= 2;

  return {
    conditionId: event.conditionId,
    marketFound: true,
    closed: true,
    resolved: resolutionFinal,
    resolutionFinal,
    outcomes: numerators.map((_, i) => `outcome_${i}`),
    outcomePrices,
    winningOutcome: winningIndex != null ? `outcome_${winningIndex}` : null,
    winningAsset: null,
    winningIndex,
    resolvedAt: null,
    umaResolutionStatus: "onchain_condition_resolution",
    resolutionStatus: resolutionFinal ? "resolved" : "unresolved_or_disputed",
    question: null,
    slug: null,
    clobTokenIds: [],
    source: "repo_cache",
    confidence: resolutionFinal ? "high" : "medium",
  };
}

export class OnChainResolutionCache {
  private readonly cache = new Map<string, OnChainResolutionEntry>();

  seedFromLogs(logs: RpcLog[]): void {
    for (const log of logs) {
      if (log.topics[0]?.toLowerCase() !== TOPIC_CONDITION_RESOLUTION) continue;
      const parsed = decodeConditionResolution(log);
      if (!parsed) continue;
      const resolution = conditionResolutionToGamma(parsed);
      this.cache.set(parsed.conditionId.toLowerCase(), {
        conditionId: parsed.conditionId,
        resolution,
        source: "onchain",
        blockNumber: parsed.blockNumber,
        transactionHash: parsed.transactionHash,
      });
    }
  }

  get(conditionId: string): OnChainResolutionEntry | undefined {
    return this.cache.get(conditionId.toLowerCase());
  }

  resolveWithPrecedence(
    conditionId: string,
    gammaCache: GammaResolutionCache
  ): GammaMarketResolution | null {
    const onchain = this.get(conditionId);
    if (onchain?.resolution.resolutionFinal) return onchain.resolution;
    const gamma = gammaCache.get(conditionId);
    if (gamma?.resolutionFinal) return gamma;
    return onchain?.resolution ?? gamma ?? null;
  }

  countFinal(): number {
    return [...this.cache.values()].filter((e) => e.resolution.resolutionFinal)
      .length;
  }

  entries(): IterableIterator<OnChainResolutionEntry> {
    return this.cache.values();
  }
}
