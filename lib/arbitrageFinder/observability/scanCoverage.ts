import { countActiveArbPairMappings } from "@/lib/arbitrageFinder/adapters/pairCatalogAdapter";
import {
  getArbScanMeta,
  setArbScanMeta,
} from "@/lib/arbitrageFinder/cache/windowCache";
import {
  aggregateScanCoverage,
  diagnosePairScan,
  formatArbitrageScanCoverageSummary,
  type ArbPairScanDiagnostic,
  type ArbitrageScanCoverageReport,
} from "@/lib/arbitrageFinder/observability/pairDiagnostics";
import { scanArbitrageWindows } from "@/lib/arbitrageFinder/windowScanner";
import { isEvRedisEnabled } from "@/lib/evPipeline/redisCache";

export {
  ARB_ORDER_BOOK_STALE_MS,
  aggregateScanCoverage,
  diagnosePairScan,
  formatArbitrageScanCoverageSummary,
  type ArbPairScanDiagnostic,
  type ArbitrageScanCoverageReport,
} from "@/lib/arbitrageFinder/observability/pairDiagnostics";

export interface CollectArbitrageScanCoverageOptions {
  mappingLimit?: number;
  recordMeta?: boolean;
  logSummary?: boolean;
}

export async function collectArbitrageScanCoverage(
  options: CollectArbitrageScanCoverageOptions = {}
): Promise<ArbitrageScanCoverageReport> {
  const mappingLimit = options.mappingLimit ?? 250;
  const [totalMappingsInDb, scan] = await Promise.all([
    countActiveArbPairMappings(),
    scanArbitrageWindows({
      mappingLimit,
      includeDiagnostics: true,
      recordMeta: false,
    }),
  ]);

  const report = aggregateScanCoverage({
    diagnostics: scan.diagnostics ?? [],
    windows: scan.windows,
    scanDurationMs: scan.scanDurationMs,
    scannedAt: new Date().toISOString(),
    mappingLimit,
    totalMappingsInDb,
    redisEnabled: isEvRedisEnabled(),
  });

  if (options.recordMeta !== false) {
    await setArbScanMeta(report);
  }

  if (options.logSummary !== false) {
    console.info(formatArbitrageScanCoverageSummary(report));
  }

  return report;
}

export async function getLatestArbitrageScanCoverage(
  options?: { fresh?: boolean; mappingLimit?: number }
): Promise<ArbitrageScanCoverageReport> {
  if (!options?.fresh) {
    const cached = await getArbScanMeta();
    if (cached?.report) return cached.report;
  }

  return collectArbitrageScanCoverage({
    mappingLimit: options?.mappingLimit,
    recordMeta: true,
    logSummary: false,
  });
}

export async function recordArbitrageScanCoverage(params: {
  diagnostics: ArbPairScanDiagnostic[];
  windows: import("@/lib/arbitrageFinder/types").ArbitrageWindow[];
  scanDurationMs: number;
  scannedAt: string;
  mappingLimit: number;
  totalMappingsInDb: number;
  logSummary?: boolean;
}): Promise<ArbitrageScanCoverageReport> {
  const report = aggregateScanCoverage({
    diagnostics: params.diagnostics,
    windows: params.windows,
    scanDurationMs: params.scanDurationMs,
    scannedAt: params.scannedAt,
    mappingLimit: params.mappingLimit,
    totalMappingsInDb: params.totalMappingsInDb,
    redisEnabled: isEvRedisEnabled(),
  });

  await setArbScanMeta(report);

  if (params.logSummary !== false) {
    console.info(formatArbitrageScanCoverageSummary(report));
  }

  return report;
}
