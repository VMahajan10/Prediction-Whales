import { desc, ne, sql } from "drizzle-orm";
import type { getDb } from "@/lib/crossmarket/store/db";
import {
  marketMappings,
  trueProbabilities,
} from "@/lib/crossmarket/store/schema";
import type { PTrueSource } from "@/lib/evPipeline/pTrueTypes";
import {
  EV_REDIS_PREFIX,
  evRedisKeys,
  execRedisReadPipeline,
  isEvRedisEnabled,
} from "@/lib/evPipeline/redisCache";
import {
  coalesceDisplayEvPercent,
  isStaleEvLookupPayload,
} from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";

type Db = ReturnType<typeof getDb>;

const HIGH_TIER_SOURCES = new Set<PTrueSource>([
  "cross_venue_ob",
  "standalone_ob",
  "sportsbook_consensus",
]);

const LOW_TIER_SOURCES = new Set<PTrueSource>([
  "universal_prior",
  "execution_price",
]);

export interface PipelineCoverageReport {
  mappingCount: number;
  latestPTrueCount: number;
  bySource: Record<string, number>;
  highTierCount: number;
  lowTierCount: number;
  lowConfidenceScoreCount: number;
  redisEnabled: boolean;
  redisLookupSample: {
    scanned: number;
    stale: number;
    ok: number;
    unmapped: number;
  };
}

export interface LatestPTrueRow {
  tokenId: string;
  kalshiTicker: string | null;
  sourceType: string;
  sourceScore: number | null;
  pTrue: number;
  calculatedAt: Date;
}

function readNumeric(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Latest p_true row per polymarket token (newest calculated_at wins). */
export function dedupeLatestPTrueRows(
  rows: LatestPTrueRow[]
): LatestPTrueRow[] {
  const byToken = new Map<string, LatestPTrueRow>();
  for (const row of rows) {
    const tokenId = row.tokenId.trim().toLowerCase();
    const existing = byToken.get(tokenId);
    if (!existing || row.calculatedAt > existing.calculatedAt) {
      byToken.set(tokenId, row);
    }
  }
  return Array.from(byToken.values());
}

export function aggregatePTrueSourceCoverage(
  rows: LatestPTrueRow[]
): Pick<
  PipelineCoverageReport,
  "bySource" | "highTierCount" | "lowTierCount" | "lowConfidenceScoreCount"
> {
  const bySource: Record<string, number> = {};
  let highTierCount = 0;
  let lowTierCount = 0;
  let lowConfidenceScoreCount = 0;

  for (const row of rows) {
    const source = row.sourceType || "unknown";
    bySource[source] = (bySource[source] ?? 0) + 1;

    if (HIGH_TIER_SOURCES.has(source as PTrueSource)) {
      highTierCount += 1;
    }
    if (LOW_TIER_SOURCES.has(source as PTrueSource)) {
      lowTierCount += 1;
    }
    if (row.sourceScore != null && row.sourceScore < 0.35) {
      lowConfidenceScoreCount += 1;
    }
  }

  return {
    bySource,
    highTierCount,
    lowTierCount,
    lowConfidenceScoreCount,
  };
}

export async function loadLatestPTrueRowsFromDb(
  db: Db,
  rowLimit = 5000
): Promise<LatestPTrueRow[]> {
  const rows = await db
    .select({
      tokenId: trueProbabilities.polymarketTokenId,
      kalshiTicker: trueProbabilities.kalshiTicker,
      sourceType: trueProbabilities.sourceType,
      sourceScore: trueProbabilities.sourceScore,
      pTrue: trueProbabilities.pTrue,
      calculatedAt: trueProbabilities.calculatedAt,
    })
    .from(trueProbabilities)
    .orderBy(desc(trueProbabilities.calculatedAt))
    .limit(rowLimit);

  const mapped = rows.map((row) => ({
    tokenId: row.tokenId,
    kalshiTicker: row.kalshiTicker,
    sourceType: row.sourceType,
    sourceScore: readNumeric(row.sourceScore),
    pTrue: readNumeric(row.pTrue) ?? 0,
    calculatedAt: row.calculatedAt,
  }));

  return dedupeLatestPTrueRows(mapped);
}

export async function countActiveMappings(db: Db): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(marketMappings)
    .where(ne(marketMappings.matchMethod, "TEST_FALLBACK_PAIR"));
  return result[0]?.count ?? 0;
}

export async function sampleRedisLookupCoverage(
  lookupKeys: string[]
): Promise<PipelineCoverageReport["redisLookupSample"]> {
  const sample = {
    scanned: 0,
    stale: 0,
    ok: 0,
    unmapped: 0,
  };

  if (lookupKeys.length === 0) return sample;

  const keys = lookupKeys.map((key) => evRedisKeys.tradeEvLookup(key));
  const batch = await execRedisReadPipeline(keys);

  for (const lookupKey of lookupKeys) {
    const raw = batch.get(evRedisKeys.tradeEvLookup(lookupKey)) as
      | PipelineTradeEv
      | undefined;
    if (!raw) continue;

    sample.scanned += 1;
    if (raw.status === "unmapped") {
      sample.unmapped += 1;
      continue;
    }
    if (isStaleEvLookupPayload(raw)) {
      sample.stale += 1;
      continue;
    }
    if (raw.status === "ok" && coalesceDisplayEvPercent(raw) != null) {
      sample.ok += 1;
    }
  }

  return sample;
}

export async function buildLookupKeysForCoverage(
  db: Db,
  latestRows: LatestPTrueRow[],
  maxKeys = 200
): Promise<string[]> {
  const keys = new Set<string>();
  for (const row of latestRows) {
    if (keys.size >= maxKeys) break;
    const tokenId = row.tokenId.trim().toLowerCase();
    keys.add(`pm:${tokenId}`);
    if (row.kalshiTicker?.trim()) {
      keys.add(`kalshi:${row.kalshiTicker.trim().toUpperCase()}`);
    }
  }

  if (keys.size >= maxKeys) {
    return Array.from(keys).slice(0, maxKeys);
  }

  const mappings = await db
    .select({
      tokenId: marketMappings.polymarketTokenId,
      kalshiTicker: marketMappings.kalshiTicker,
    })
    .from(marketMappings)
    .where(ne(marketMappings.matchMethod, "TEST_FALLBACK_PAIR"))
    .orderBy(desc(marketMappings.updatedAt))
    .limit(maxKeys);

  for (const row of mappings) {
    if (keys.size >= maxKeys) break;
    keys.add(`pm:${row.tokenId.toLowerCase()}`);
    keys.add(`kalshi:${row.kalshiTicker.toUpperCase()}`);
  }

  return Array.from(keys).slice(0, maxKeys);
}

export async function collectPipelineCoverageReport(
  db: Db,
  options?: { rowLimit?: number; redisSampleSize?: number }
): Promise<PipelineCoverageReport> {
  const rowLimit = options?.rowLimit ?? 5000;
  const redisSampleSize = options?.redisSampleSize ?? 200;

  const [mappingCount, rawRows] = await Promise.all([
    countActiveMappings(db),
    loadLatestPTrueRowsFromDb(db, rowLimit),
  ]);

  const latest = dedupeLatestPTrueRows(rawRows);
  const aggregates = aggregatePTrueSourceCoverage(latest);
  const lookupKeys = await buildLookupKeysForCoverage(
    db,
    latest,
    redisSampleSize
  );
  const redisLookupSample = await sampleRedisLookupCoverage(lookupKeys);

  return {
    mappingCount,
    latestPTrueCount: latest.length,
    ...aggregates,
    redisEnabled: isEvRedisEnabled(),
    redisLookupSample,
  };
}

export function formatPipelineCoverageSummary(
  report: PipelineCoverageReport
): string {
  const sourceLines = Object.entries(report.bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `  ${source}: ${count}`)
    .join("\n");

  const highPct =
    report.latestPTrueCount > 0
      ? ((report.highTierCount / report.latestPTrueCount) * 100).toFixed(1)
      : "0.0";
  const lowPct =
    report.latestPTrueCount > 0
      ? ((report.lowTierCount / report.latestPTrueCount) * 100).toFixed(1)
      : "0.0";

  return [
    "[ev-pipeline] coverage summary",
    `  mappings: ${report.mappingCount}`,
    `  latest p_true rows: ${report.latestPTrueCount}`,
    `  high-tier (OB/sportsbook): ${report.highTierCount} (${highPct}%)`,
    `  low-tier (prior/execution): ${report.lowTierCount} (${lowPct}%)`,
    `  low source_score (<0.35): ${report.lowConfidenceScoreCount}`,
    "  by source:",
    sourceLines || "  (none)",
    `  redis: ${report.redisEnabled ? "enabled" : "disabled"}`,
    `  redis lookup sample: scanned=${report.redisLookupSample.scanned} ok=${report.redisLookupSample.ok} stale=${report.redisLookupSample.stale} unmapped=${report.redisLookupSample.unmapped}`,
  ].join("\n");
}
