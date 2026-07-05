import {
  normalizeKalshiTicker,
  normalizePmTokenId,
  pipelineMappingPairKey,
} from "@/lib/evPipeline/crossAssetLookup";
import {
  getCachedArbWindows,
  setCachedArbWindows,
} from "@/lib/arbitrageFinder/cache/windowCache";
import {
  resolveMappingByKalshiTicker,
  resolveMappingByPmToken,
  resolveMappingForPair,
} from "@/lib/arbitrageFinder/adapters/mappingAdapter";
import {
  attachStakePlan,
  attachStakePlans,
  type AttachStakePlanOptions,
} from "@/lib/arbitrageFinder/stakeOptimizer";
import type {
  ArbitrageWindow,
  ArbitrageWindowScanResult,
  WindowScannerOptions,
} from "@/lib/arbitrageFinder/types";
import {
  pickBestActionableWindow,
  scanArbitrageWindowForPair,
  scanArbitrageWindows,
  scanArbitrageWindowsForPair,
} from "@/lib/arbitrageFinder/windowScanner";
import { fetchPairOrderBooks } from "@/lib/arbitrageFinder/adapters/orderBookAdapter";

export interface ResolvePairIdentifiersInput {
  pmTokenId?: string | null;
  kalshiTicker?: string | null;
}

export interface WindowServiceOptions extends WindowScannerOptions {
  stakeUsd?: number | null;
  bestOnly?: boolean;
  useCache?: boolean;
  mappingLimit?: number;
}

export interface ArbitrageWindowPairResult {
  pairKey: string | null;
  windows: ArbitrageWindow[];
  best: ArbitrageWindow | null;
  fromCache: boolean;
}

function parseStakeUsd(raw: unknown): number | null {
  if (raw == null) return null;
  const parsed = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function stakeOptions(stakeUsd: number | null | undefined): AttachStakePlanOptions | null {
  const total = parseStakeUsd(stakeUsd);
  if (total == null) return null;
  return { totalStakeUsd: total };
}

function applyStake(
  windows: ArbitrageWindow[],
  stakeUsd: number | null | undefined
): ArbitrageWindow[] {
  const opts = stakeOptions(stakeUsd);
  if (!opts) return windows;
  return attachStakePlans(windows, opts);
}

export async function resolvePairIdentifiers(
  input: ResolvePairIdentifiersInput
): Promise<{
  polymarketTokenId: string;
  kalshiTicker: string;
} | null> {
  const tokenId = normalizePmTokenId(input.pmTokenId ?? null);
  const ticker = normalizeKalshiTicker(input.kalshiTicker ?? null);

  if (tokenId && ticker) {
    return { polymarketTokenId: tokenId, kalshiTicker: ticker };
  }

  if (tokenId) {
    const mapping = await resolveMappingByPmToken(tokenId);
    if (!mapping) return null;
    return {
      polymarketTokenId: mapping.polymarketTokenId,
      kalshiTicker: mapping.kalshiTicker,
    };
  }

  if (ticker) {
    const mapping = await resolveMappingByKalshiTicker(ticker);
    if (!mapping) return null;
    return {
      polymarketTokenId: mapping.polymarketTokenId,
      kalshiTicker: mapping.kalshiTicker,
    };
  }

  return null;
}

export async function getArbitrageWindowsForPair(
  input: ResolvePairIdentifiersInput,
  options: WindowServiceOptions = {}
): Promise<ArbitrageWindowPairResult> {
  const resolved = await resolvePairIdentifiers(input);
  if (!resolved) {
    return { pairKey: null, windows: [], best: null, fromCache: false };
  }

  const pairKey = pipelineMappingPairKey(
    resolved.polymarketTokenId,
    resolved.kalshiTicker
  );

  if (options.useCache !== false) {
    const cached = await getCachedArbWindows(pairKey);
    if (cached?.windows?.length) {
      const windows = applyStake(cached.windows, options.stakeUsd);
      const best = pickBestActionableWindow(windows);
      return {
        pairKey,
        windows: options.bestOnly && best ? [best] : windows,
        best,
        fromCache: true,
      };
    }
  }

  let windows = await scanArbitrageWindowForPair(
    resolved.polymarketTokenId,
    resolved.kalshiTicker,
    options
  );

  if (windows.length > 0 && options.useCache !== false) {
    await setCachedArbWindows(pairKey, windows);
  }

  windows = applyStake(windows, options.stakeUsd);
  const best = pickBestActionableWindow(windows);

  if (options.bestOnly && best) {
    return { pairKey, windows: [best], best, fromCache: false };
  }

  return { pairKey, windows, best, fromCache: false };
}

export async function scanArbitrageWindowsWithStake(
  options: WindowServiceOptions = {}
): Promise<ArbitrageWindowScanResult> {
  const result = await scanArbitrageWindows(options);
  const windows = applyStake(result.windows, options.stakeUsd);
  return {
    ...result,
    windows,
    actionableCount: windows.filter((w) => w.isActionable).length,
  };
}

export interface BatchPairScanItem {
  polymarketTokenId: string;
  kalshiTicker: string;
}

export async function scanArbitrageWindowsBatch(
  pairs: BatchPairScanItem[],
  options: WindowServiceOptions = {}
): Promise<{
  results: Array<ArbitrageWindowPairResult & { polymarketTokenId: string; kalshiTicker: string }>;
  scanDurationMs: number;
}> {
  const started = Date.now();
  const results: Array<
    ArbitrageWindowPairResult & {
      polymarketTokenId: string;
      kalshiTicker: string;
    }
  > = [];

  const scannedAt = options.scannedAt ?? new Date().toISOString();

  await Promise.all(
    pairs.map(async (pair) => {
      const tokenId = normalizePmTokenId(pair.polymarketTokenId);
      const ticker = normalizeKalshiTicker(pair.kalshiTicker);
      if (!tokenId || !ticker) return;

      const pairKey = pipelineMappingPairKey(tokenId, ticker);
      const [mapping, books] = await Promise.all([
        resolveMappingForPair(tokenId, ticker),
        fetchPairOrderBooks(tokenId, ticker),
      ]);

      if (!mapping) {
        results.push({
          polymarketTokenId: tokenId,
          kalshiTicker: ticker,
          pairKey,
          windows: [],
          best: null,
          fromCache: false,
        });
        return;
      }

      let windows = scanArbitrageWindowsForPair(
        {
          mapping,
          pmOb: books.pmOb,
          kalshiOb: books.kalshiOb,
        },
        { ...options, scannedAt }
      );

      if (windows.length > 0 && options.useCache !== false) {
        await setCachedArbWindows(pairKey, windows);
      }

      windows = applyStake(windows, options.stakeUsd);
      const best = pickBestActionableWindow(windows);

      results.push({
        polymarketTokenId: tokenId,
        kalshiTicker: ticker,
        pairKey,
        windows: options.bestOnly && best ? [best] : windows,
        best,
        fromCache: false,
      });
    })
  );

  return {
    results: results.sort(
      (a, b) => (b.best?.roiPercent ?? 0) - (a.best?.roiPercent ?? 0)
    ),
    scanDurationMs: Date.now() - started,
  };
}

export { attachStakePlan, parseStakeUsd };
