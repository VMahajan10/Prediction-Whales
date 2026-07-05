import { pipelineMappingPairKey } from "@/lib/evPipeline/crossAssetLookup";
import { maxOrderBookStalenessMs } from "@/lib/arbitrageFinder/adapters/orderBookAdapter";
import type {
  ArbPairMapping,
  ArbitrageWindow,
  ArbRejectReason,
} from "@/lib/arbitrageFinder/types";
import type { CachedOrderBookMid } from "@/lib/evPipeline/redisCache";

/** Matches ArbitrageDiscrepancyBox stale threshold. */
export const ARB_ORDER_BOOK_STALE_MS = 60_000;

export interface ArbPairScanDiagnostic {
  polymarketTokenId: string;
  kalshiTicker: string;
  mappingPairKey: string;
  matchMethod: string;
  orientation: "same" | "inverted";
  hasPmOrderBook: boolean;
  hasKalshiOrderBook: boolean;
  hasBothOrderBooks: boolean;
  pmStalenessMs: number | null;
  kalshiStalenessMs: number | null;
  maxLegStalenessMs: number;
  isStale: boolean;
  windowCount: number;
  actionableCount: number;
  bestRoiPercent: number | null;
  rejectReasons: ArbRejectReason[];
}

export interface ArbitrageScanCoverageReport {
  scannedAt: string;
  mappingLimit: number;
  totalMappingsInDb: number;
  scannedPairs: number;
  pairsWithBothBooks: number;
  pairsMissingPmBook: number;
  pairsMissingKalshiBook: number;
  pairsMissingAnyBook: number;
  pairsStaleBooks: number;
  pairsInverted: number;
  pairsScannable: number;
  windowCount: number;
  actionableWindowCount: number;
  actionablePairCount: number;
  scanDurationMs: number;
  bothBooksRatePercent: number;
  staleBookRatePercent: number;
  actionablePairRatePercent: number;
  byRejectReason: Record<string, number>;
  byMatchMethod: Record<string, number>;
  topActionableRoiPercent: number | null;
  redisEnabled: boolean;
}

function readStalenessMs(
  ob: CachedOrderBookMid | null,
  nowMs: number
): number | null {
  if (!ob?.ts) return null;
  return Math.max(0, nowMs - ob.ts);
}

export function diagnosePairScan(params: {
  mapping: ArbPairMapping;
  pmOb: CachedOrderBookMid | null;
  kalshiOb: CachedOrderBookMid | null;
  windows: ArbitrageWindow[];
  nowMs?: number;
}): ArbPairScanDiagnostic {
  const nowMs = params.nowMs ?? Date.now();
  const { mapping, pmOb, kalshiOb, windows } = params;
  const hasPmOrderBook = pmOb != null;
  const hasKalshiOrderBook = kalshiOb != null;
  const hasBothOrderBooks = hasPmOrderBook && hasKalshiOrderBook;
  const maxLegStalenessMs = maxOrderBookStalenessMs({ pmOb, kalshiOb }, nowMs);
  const actionable = windows.filter((w) => w.isActionable);
  const rejectReasons = Array.from(
    new Set(
      windows
        .map((w) => w.rejectReason)
        .filter((reason): reason is ArbRejectReason => reason != null)
    )
  );

  if (!hasPmOrderBook || !hasKalshiOrderBook) {
    if (!rejectReasons.includes("missing_order_book")) {
      rejectReasons.push("missing_order_book");
    }
  }

  return {
    polymarketTokenId: mapping.polymarketTokenId,
    kalshiTicker: mapping.kalshiTicker,
    mappingPairKey: pipelineMappingPairKey(
      mapping.polymarketTokenId,
      mapping.kalshiTicker
    ),
    matchMethod: mapping.matchMethod,
    orientation: mapping.orientation,
    hasPmOrderBook,
    hasKalshiOrderBook,
    hasBothOrderBooks,
    pmStalenessMs: readStalenessMs(pmOb, nowMs),
    kalshiStalenessMs: readStalenessMs(kalshiOb, nowMs),
    maxLegStalenessMs,
    isStale:
      hasBothOrderBooks &&
      Number.isFinite(maxLegStalenessMs) &&
      maxLegStalenessMs > ARB_ORDER_BOOK_STALE_MS,
    windowCount: windows.length,
    actionableCount: actionable.length,
    bestRoiPercent:
      actionable.length > 0
        ? Math.max(...actionable.map((w) => w.roiPercent))
        : null,
    rejectReasons,
  };
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function aggregateScanCoverage(params: {
  diagnostics: ArbPairScanDiagnostic[];
  windows: ArbitrageWindow[];
  scanDurationMs: number;
  scannedAt: string;
  mappingLimit: number;
  totalMappingsInDb: number;
  redisEnabled: boolean;
}): ArbitrageScanCoverageReport {
  const { diagnostics, windows, scanDurationMs, scannedAt } = params;
  const scannedPairs = diagnostics.length;
  const pairsWithBothBooks = diagnostics.filter((d) => d.hasBothOrderBooks).length;
  const pairsMissingPmBook = diagnostics.filter((d) => !d.hasPmOrderBook).length;
  const pairsMissingKalshiBook = diagnostics.filter(
    (d) => !d.hasKalshiOrderBook
  ).length;
  const pairsMissingAnyBook = diagnostics.filter(
    (d) => !d.hasBothOrderBooks
  ).length;
  const pairsStaleBooks = diagnostics.filter((d) => d.isStale).length;
  const pairsInverted = diagnostics.filter((d) => d.orientation === "inverted").length;
  const pairsScannable = diagnostics.filter(
    (d) => d.hasBothOrderBooks && d.orientation === "same"
  ).length;
  const actionableWindowCount = windows.filter((w) => w.isActionable).length;
  const actionablePairCount = diagnostics.filter((d) => d.actionableCount > 0).length;

  const byRejectReason: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    for (const reason of diagnostic.rejectReasons) {
      byRejectReason[reason] = (byRejectReason[reason] ?? 0) + 1;
    }
  }

  const byMatchMethod: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    const method = diagnostic.matchMethod || "unknown";
    byMatchMethod[method] = (byMatchMethod[method] ?? 0) + 1;
  }

  const actionableRois = windows
    .filter((w) => w.isActionable)
    .map((w) => w.roiPercent);

  return {
    scannedAt,
    mappingLimit: params.mappingLimit,
    totalMappingsInDb: params.totalMappingsInDb,
    scannedPairs,
    pairsWithBothBooks,
    pairsMissingPmBook,
    pairsMissingKalshiBook,
    pairsMissingAnyBook,
    pairsStaleBooks,
    pairsInverted,
    pairsScannable,
    windowCount: windows.length,
    actionableWindowCount,
    actionablePairCount,
    scanDurationMs,
    bothBooksRatePercent: pct(pairsWithBothBooks, scannedPairs),
    staleBookRatePercent: pct(pairsStaleBooks, pairsWithBothBooks),
    actionablePairRatePercent: pct(actionablePairCount, pairsScannable),
    byRejectReason,
    byMatchMethod,
    topActionableRoiPercent:
      actionableRois.length > 0 ? Math.max(...actionableRois) : null,
    redisEnabled: params.redisEnabled,
  };
}

export function formatArbitrageScanCoverageSummary(
  report: ArbitrageScanCoverageReport
): string {
  const rejectLines = Object.entries(report.byRejectReason)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `  ${reason}: ${count}`)
    .join("\n");

  const methodLines = Object.entries(report.byMatchMethod)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([method, count]) => `  ${method}: ${count}`)
    .join("\n");

  return [
    "[arb-finder] scan coverage summary",
    `  scanned at: ${report.scannedAt}`,
    `  mappings in db: ${report.totalMappingsInDb} (limit ${report.mappingLimit})`,
    `  pairs scanned: ${report.scannedPairs}`,
    `  both order books: ${report.pairsWithBothBooks} (${report.bothBooksRatePercent}%)`,
    `  missing PM book: ${report.pairsMissingPmBook}`,
    `  missing Kalshi book: ${report.pairsMissingKalshiBook}`,
    `  stale books (>60s): ${report.pairsStaleBooks} (${report.staleBookRatePercent}% of both-book pairs)`,
    `  inverted mappings: ${report.pairsInverted}`,
    `  scannable (both + same orientation): ${report.pairsScannable}`,
    `  windows: ${report.windowCount} (${report.actionableWindowCount} actionable)`,
    `  actionable pairs: ${report.actionablePairCount} (${report.actionablePairRatePercent}% of scannable)`,
    `  top lock ROI: ${
      report.topActionableRoiPercent != null
        ? `${report.topActionableRoiPercent.toFixed(1)}%`
        : "none"
    }`,
    `  scan duration: ${report.scanDurationMs}ms`,
    "  reject reasons:",
    rejectLines || "  (none)",
    "  by match method:",
    methodLines || "  (none)",
    `  redis: ${report.redisEnabled ? "enabled" : "disabled"}`,
  ].join("\n");
}
