/**
 * Scan mapped PM↔Kalshi pairs for sub-100% box locks.
 * Read-only — no writes to true_probabilities or EV caches.
 */

import { pipelineMappingPairKey } from "@/lib/evPipeline/crossAssetLookup";
import { prefetchMappingRedisBatch } from "@/lib/evPipeline/redisCache";
import {
  evaluateBinaryBoxArbitrage,
  evaluateDirectionalWindows,
} from "@/lib/finance/arbitrageEngine";
import { deriveYesNoAsksFromOrderBook } from "@/lib/finance/orderBookQuotes";
import { loadActiveArbPairMappings } from "@/lib/arbitrageFinder/adapters/pairCatalogAdapter";
import {
  fetchPairOrderBooks,
  maxOrderBookStalenessMs,
} from "@/lib/arbitrageFinder/adapters/orderBookAdapter";
import { resolveMappingForPair } from "@/lib/arbitrageFinder/adapters/mappingAdapter";
import { countActiveArbPairMappings } from "@/lib/arbitrageFinder/adapters/pairCatalogAdapter";
import type { ArbPairScanDiagnostic } from "@/lib/arbitrageFinder/observability/pairDiagnostics";
import { diagnosePairScan } from "@/lib/arbitrageFinder/observability/pairDiagnostics";
import { recordArbitrageScanCoverage } from "@/lib/arbitrageFinder/observability/scanCoverage";
import type {
  ArbExecutableLeg,
  ArbPairMapping,
  ArbitrageWindow,
  ArbitrageWindowScanResult,
  ArbWindowStrategy,
  ScanPairInput,
  WindowScannerOptions,
} from "@/lib/arbitrageFinder/types";

function buildWindowId(
  mappingPairKey: string,
  strategy: ArbWindowStrategy
): string {
  return `window:${mappingPairKey}:${strategy}`;
}

function buildLeg(
  venue: ArbExecutableLeg["venue"],
  side: ArbExecutableLeg["side"],
  contractId: string,
  askPrice: number,
  orderBookTs: number
): ArbExecutableLeg {
  return {
    venue,
    side,
    contractId,
    askPrice,
    orderBookTs,
    source: "order_book",
  };
}

function materializeWindow(params: {
  mapping: ArbPairMapping;
  strategy: ArbWindowStrategy;
  legs: [ArbExecutableLeg, ArbExecutableLeg];
  math: ReturnType<typeof evaluateBinaryBoxArbitrage>;
  maxLegStalenessMs: number;
  scannedAt: string;
  rejectReason?: ArbitrageWindow["rejectReason"];
}): ArbitrageWindow {
  const mappingPairKey = pipelineMappingPairKey(
    params.mapping.polymarketTokenId,
    params.mapping.kalshiTicker
  );

  return {
    windowId: buildWindowId(mappingPairKey, params.strategy),
    mappingPairKey,
    polymarketTokenId: params.mapping.polymarketTokenId,
    kalshiTicker: params.mapping.kalshiTicker,
    strategy: params.strategy,
    legs: params.legs,
    combinedCost: params.math.combinedCost,
    impliedSumPercent: params.math.impliedSumPercent,
    inverseOddsSumPercent: params.math.inverseOddsSumPercent,
    isActionable: params.math.isActionable,
    profitDeltaPerUnit: params.math.profitDeltaPerUnit,
    roiPercent: params.math.roiPercent,
    scannedAt: params.scannedAt,
    maxLegStalenessMs: params.maxLegStalenessMs,
    orientation: params.mapping.orientation,
    matchMethod: params.mapping.matchMethod,
    rejectReason: params.rejectReason ?? params.math.rejectReason,
  };
}

/** Evaluate one pair when mapping + order books are already loaded. */
export function scanArbitrageWindowsForPair(
  input: ScanPairInput,
  options: WindowScannerOptions = {}
): ArbitrageWindow[] {
  const scannedAt = options.scannedAt ?? new Date().toISOString();
  const nowMs = options.nowMs ?? Date.now();
  const engineOpts = {
    maxCombinedCost: options.maxCombinedCost,
  };

  const { mapping, pmOb, kalshiOb } = input;
  const maxLegStalenessMs = maxOrderBookStalenessMs(
    { pmOb, kalshiOb },
    nowMs
  );

  if (mapping.orientation === "inverted") {
    return [];
  }

  const pm = deriveYesNoAsksFromOrderBook(pmOb);
  const kalshi = deriveYesNoAsksFromOrderBook(kalshiOb);
  if (!pm || !kalshi) return [];

  const directional = evaluateDirectionalWindows(
    pm.yesAsk,
    pm.noAsk,
    kalshi.yesAsk,
    kalshi.noAsk,
    engineOpts
  );

  const windows: ArbitrageWindow[] = [];
  const tokenId = mapping.polymarketTokenId;
  const ticker = mapping.kalshiTicker;

  if (directional.pmYesKalshiNo) {
    windows.push(
      materializeWindow({
        mapping,
        strategy: "pm_yes_kalshi_no",
        legs: [
          buildLeg(
            "polymarket",
            "YES",
            tokenId,
            pm.yesAsk,
            pmOb?.ts ?? nowMs
          ),
          buildLeg(
            "kalshi",
            "NO",
            ticker,
            kalshi.noAsk,
            kalshiOb?.ts ?? nowMs
          ),
        ],
        math: directional.pmYesKalshiNo,
        maxLegStalenessMs,
        scannedAt,
      })
    );
  }

  if (directional.kalshiYesPmNo) {
    windows.push(
      materializeWindow({
        mapping,
        strategy: "kalshi_yes_pm_no",
        legs: [
          buildLeg(
            "kalshi",
            "YES",
            ticker,
            kalshi.yesAsk,
            kalshiOb?.ts ?? nowMs
          ),
          buildLeg(
            "polymarket",
            "NO",
            tokenId,
            pm.noAsk,
            pmOb?.ts ?? nowMs
          ),
        ],
        math: directional.kalshiYesPmNo,
        maxLegStalenessMs,
        scannedAt,
      })
    );
  }

  return windows;
}

export async function scanArbitrageWindowForPair(
  polymarketTokenId: string,
  kalshiTicker: string,
  options: WindowScannerOptions = {}
): Promise<ArbitrageWindow[]> {
  const [mapping, books] = await Promise.all([
    resolveMappingForPair(polymarketTokenId, kalshiTicker),
    fetchPairOrderBooks(polymarketTokenId, kalshiTicker),
  ]);

  if (!mapping) return [];

  return scanArbitrageWindowsForPair(
    {
      mapping,
      pmOb: books.pmOb,
      kalshiOb: books.kalshiOb,
    },
    options
  );
}

export async function scanArbitrageWindows(
  options: WindowScannerOptions & {
    mappingLimit?: number;
    includeDiagnostics?: boolean;
    recordMeta?: boolean;
  } = {}
): Promise<
  ArbitrageWindowScanResult & { diagnostics?: ArbPairScanDiagnostic[] }
> {
  const started = Date.now();
  const mappingLimit = options.mappingLimit ?? 2000;
  const mappings = await loadActiveArbPairMappings(mappingLimit);
  if (mappings.length === 0) {
    return {
      windows: [],
      scannedPairs: 0,
      actionableCount: 0,
      scanDurationMs: Date.now() - started,
      diagnostics: options.includeDiagnostics ? [] : undefined,
    };
  }

  const prefetch = await prefetchMappingRedisBatch(
    mappings.map((m) => ({
      polymarketTokenId: m.polymarketTokenId,
      kalshiTicker: m.kalshiTicker,
    }))
  );

  const windows: ArbitrageWindow[] = [];
  const diagnostics: ArbPairScanDiagnostic[] = [];
  const scannedAt = options.scannedAt ?? new Date().toISOString();
  const nowMs = options.nowMs ?? Date.now();

  for (const mapping of mappings) {
    const pairKey = pipelineMappingPairKey(
      mapping.polymarketTokenId,
      mapping.kalshiTicker
    );
    const books = prefetch.get(pairKey);
    const pmOb = books?.pmOb ?? null;
    const kalshiOb = books?.kalshiOb ?? null;
    const pairWindows = scanArbitrageWindowsForPair(
      {
        mapping,
        pmOb,
        kalshiOb,
      },
      { ...options, scannedAt, nowMs }
    );
    windows.push(...pairWindows);

    diagnostics.push(
      diagnosePairScan({
        mapping,
        pmOb,
        kalshiOb,
        windows: pairWindows,
        nowMs,
      })
    );
  }

  const actionableCount = windows.filter((w) => w.isActionable).length;
  const scanDurationMs = Date.now() - started;
  const sortedWindows = windows.sort((a, b) => b.roiPercent - a.roiPercent);

  if (options.recordMeta !== false) {
    void countActiveArbPairMappings()
      .then((totalMappingsInDb) =>
        recordArbitrageScanCoverage({
          diagnostics,
          windows: sortedWindows,
          scanDurationMs,
          scannedAt,
          mappingLimit,
          totalMappingsInDb,
          logSummary: true,
        })
      )
      .catch((err) => {
        console.warn(
          "[arb-finder] scan meta recording failed:",
          err instanceof Error ? err.message : err
        );
      });
  }

  return {
    windows: sortedWindows,
    scannedPairs: mappings.length,
    actionableCount,
    scanDurationMs,
    diagnostics: options.includeDiagnostics ? diagnostics : undefined,
  };
}

/** Best actionable window for a pair, if any. */
export function pickBestActionableWindow(
  windows: ArbitrageWindow[]
): ArbitrageWindow | null {
  const actionable = windows.filter((w) => w.isActionable);
  if (actionable.length === 0) return null;
  return actionable.sort((a, b) => b.roiPercent - a.roiPercent)[0] ?? null;
}
