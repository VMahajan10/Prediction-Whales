import { CLV_CONSTANTS } from "@/lib/clvPriceHistory";
import {
  buildCrossMarketBookIndex,
  parsePmMoneylineSlug,
  type CrossMarketEvReason,
  type CrossMarketFairSource,
  type OutcomeBooks,
} from "@/lib/crossMarketEv";
import { resolveCrossMarketEvForTrade } from "@/lib/resolveTradeCrossMarketEv";

export interface CrossMarketEvPositionResult {
  slug: string;
  title: string;
  avgPrice: number;
  ev: number | null;
  fairSource: CrossMarketFairSource | null;
  reason: CrossMarketEvReason;
  valid: boolean;
}

function predominantFairSource(
  valid: CrossMarketEvPositionResult[]
): CrossMarketFairSource | null {
  const counts: Record<string, number> = {};
  for (const p of valid) {
    if (!p.fairSource) continue;
    counts[p.fairSource] = (counts[p.fairSource] ?? 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (ranked[0]?.[0] as CrossMarketFairSource | undefined) ?? null;
}

export interface CrossMarketEvStats {
  avgEv: number | null;
  coverage: number;
  /** Resolved closed positions considered. */
  totalClosed: number;
  /** Open positions also evaluated (forward-looking EV). */
  openEvaluated: number;
  /** Total positions evaluated (closed + open with parseable sports slugs). */
  totalEvaluated: number;
  hasEnoughCoverage: boolean;
  coverageFloor: number;
  /** Predominant fair-reference venue across valid matches. */
  fairSource: CrossMarketFairSource | null;
  positions: CrossMarketEvPositionResult[];
}

function isSportsMoneylinePosition(raw: { slug?: string }): boolean {
  const slug = raw.slug ?? "";
  return !!slug && !!parsePmMoneylineSlug(slug);
}

function evaluatePosition(
  raw: {
    slug?: string;
    title?: string;
    avgPrice?: number;
    curPrice?: number;
  },
  bookIndex: Map<string, OutcomeBooks>
): CrossMarketEvPositionResult {
  const slug = raw.slug ?? "";
  const avgPrice = raw.avgPrice ?? null;
  const title = raw.title ?? "Unknown market";

  if (!slug || avgPrice == null || avgPrice <= 0) {
    return {
      slug,
      title,
      avgPrice: avgPrice ?? 0,
      ev: null,
      fairSource: null,
      reason: "no_match",
      valid: false,
    };
  }

  const result = resolveCrossMarketEvForTrade(
    { source: "polymarket", price: avgPrice, slug },
    bookIndex
  );

  return {
    slug,
    title,
    avgPrice,
    ev: result.ev,
    fairSource: result.fairSource,
    reason: result.reason ?? "no_match",
    valid: result.reason === "ok" && result.ev != null,
  };
}

/**
 * Aggregate cross-market EV across closed + open Polymarket sports positions.
 * Reuses the deterministic sports matcher + liveness/orientation guards.
 */
export async function computeCrossMarketEvStats(
  closedPositions: unknown[],
  openPositions: unknown[] = [],
  options?: {
    index?: Map<string, OutcomeBooks>;
    includeManifold?: boolean;
    includeSportsbook?: boolean;
  }
): Promise<CrossMarketEvStats> {
  const coverageFloor = CLV_CONSTANTS.COVERAGE_FLOOR;
  const resolved = closedPositions.filter((p) => {
    const row = p as { curPrice?: number };
    return row.curPrice === 0 || row.curPrice === 1;
  });
  const totalClosed = resolved.length;

  const bookIndex =
    options?.index ??
    (await buildCrossMarketBookIndex({
      includeManifold: options?.includeManifold !== false,
      includeSportsbook: options?.includeSportsbook !== false,
    }));
  const positions: CrossMarketEvPositionResult[] = [];

  for (const raw of resolved) {
    if (!isSportsMoneylinePosition(raw as { slug?: string })) continue;
    positions.push(
      evaluatePosition(
        raw as { slug?: string; title?: string; avgPrice?: number },
        bookIndex
      )
    );
  }

  let openEvaluated = 0;
  for (const raw of openPositions) {
    if (!isSportsMoneylinePosition(raw as { slug?: string })) continue;
    openEvaluated++;
    positions.push(
      evaluatePosition(
        raw as { slug?: string; title?: string; avgPrice?: number },
        bookIndex
      )
    );
  }

  const totalEvaluated = positions.length;
  if (totalEvaluated === 0) {
    return {
      avgEv: null,
      coverage: 0,
      totalClosed,
      openEvaluated: 0,
      totalEvaluated: 0,
      hasEnoughCoverage: false,
      coverageFloor,
      fairSource: null,
      positions: [],
    };
  }

  const valid = positions.filter((p) => p.valid && p.ev != null);
  const coverage = valid.length;
  const avgEv =
    coverage > 0
      ? Math.round(
          (valid.reduce((sum, p) => sum + (p.ev ?? 0), 0) / coverage) * 10
        ) / 10
      : null;

  return {
    avgEv,
    coverage,
    totalClosed,
    openEvaluated,
    totalEvaluated,
    hasEnoughCoverage: coverage >= coverageFloor,
    coverageFloor,
    fairSource: predominantFairSource(valid),
    positions,
  };
}
