import { eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  marketMappings,
  syncRuns,
  trueProbabilities,
  traderEvAnalytics,
  type SyncRunCounts,
} from "@/lib/crossmarket/store/schema";
import { runMarketMapping } from "@/lib/evPipeline/mapMarkets";
import { logger } from "@/lib/logger";
import {
  DEFAULT_KALSHI_MAX_PAGES,
  DEFAULT_PM_LIMIT,
} from "@/lib/evPipeline/marketFetch";
import { processMappedPTrue, ensureMappedTradeEvLookups } from "@/lib/evPipeline/computeMappedEv";
import { warmWhaleFeedTradeEv } from "@/lib/evPipeline/warmWhaleFeedEv";
import type { MatchedPair } from "@/lib/evPipeline/types";
import {
  formatPreflightErrors,
  validateMatchMarketsPreflight,
} from "@/lib/evPipeline/matchMarketsPreflight";
import {
  cacheOrderBookMidBatch,
  cacheMappingBothWaysBatch,
  cachePTrue,
  cacheTraderEv,
  evRedisKeys,
  initGlobalLocalEvCache,
} from "@/lib/evPipeline/redisCache";
import { runOrderBookIngest } from "@/lib/evPipeline/orderBookIngest";
import { refreshConsensusIndex } from "@/lib/evPipeline/consensusIndexBuilder";
import { ingestRagContext } from "@/lib/ai/rag/ingestRagContext";
import {
  collectPipelineCoverageReport,
  formatPipelineCoverageSummary,
} from "@/lib/evPipeline/pipelineCoverage";

initGlobalLocalEvCache();

export interface PipelineStageResult {
  ok: boolean;
  count?: number;
  ms?: number;
  error?: string;
}

export interface EvPipelineResult {
  runId: string;
  stages: {
    ingestOrderBooks: PipelineStageResult;
    matchMarkets: PipelineStageResult;
    refreshConsensusIndex: PipelineStageResult;
    ingestRagContext: PipelineStageResult;
    computePTrue: PipelineStageResult;
    warmWhaleFeedEv: PipelineStageResult;
    computeTraderEv: PipelineStageResult;
  };
}

function elapsed(start: number): number {
  return Date.now() - start;
}

/** Pairs from the current pipeline run (matchMarkets → downstream stages). */
let activeMatchedPairs: MatchedPair[] = [];

/**
 * Stage 1 — Fetch PM CLOB + Kalshi order books; cache mids in Redis.
 * Implementation: batch active mappings + whale feed tickers.
 */
export async function ingestOrderBooks(): Promise<PipelineStageResult> {
  const start = Date.now();
  try {
    const result = await runOrderBookIngest();
    return {
      ok: true,
      count: result.totalCached,
      ms: elapsed(start),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "ingestOrderBooks failed",
      ms: elapsed(start),
    };
  }
}

/**
 * Stage 2 — Embedding similarity → upsert market_mappings.
 */
export async function matchMarkets(): Promise<PipelineStageResult> {
  const start = Date.now();

  try {
    const preflight = validateMatchMarketsPreflight({ persist: true });
    if (preflight.warnings.length > 0) {
      for (const warning of preflight.warnings) {
        console.warn(`[ev-pipeline] matchMarkets warning: ${warning}`);
      }
    }
    if (!preflight.ok) {
      const error = formatPreflightErrors(preflight);
      console.error("[ev-pipeline] matchMarkets preflight failed:", preflight.errors);
      return { ok: false, count: 0, error, ms: elapsed(start) };
    }

    logger.info("[ev-pipeline] matchMarkets stage starting…");
    const result = await runMarketMapping({
      persist: true,
      polymarketLimit: DEFAULT_PM_LIMIT,
      kalshiMaxPages: DEFAULT_KALSHI_MAX_PAGES,
    });
    activeMatchedPairs = result.matches.filter(
      (m) => m.matchMethod !== "TEST_FALLBACK_PAIR"
    );

    logger.info("[ev-pipeline] matchMarkets stage finished:", {
      ok: result.ok,
      polymarketCount: result.polymarketCount,
      kalshiCount: result.kalshiCount,
      embeddedCount: result.embeddedCount,
      matchedCount: result.matchedCount,
      persistedCount: result.persistedCount,
      threshold: result.threshold,
      failureCount: result.failures.length,
      durationMs: result.durationMs,
    });

    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        console.error(
          `[ev-pipeline] matchMarkets failure (${failure.stage}):`,
          failure.message,
          failure.polymarketTokenId
            ? { polymarketTokenId: failure.polymarketTokenId }
            : {},
          failure.kalshiTicker ? { kalshiTicker: failure.kalshiTicker } : {}
        );
      }
    }

    if (result.ok) {
      return {
        ok: true,
        count:
          result.persistedCount > 0
            ? result.persistedCount
            : result.matchedCount,
        ms: elapsed(start),
      };
    }

    const criticalFailures = result.failures.filter(
      (f) =>
        f.stage === "fetch_polymarket" ||
        f.stage === "fetch_kalshi" ||
        f.stage === "embed" ||
        f.stage === "match"
    );

    if (criticalFailures.length > 0) {
      const error = criticalFailures
        .map((f) => `${f.stage}: ${f.message}`)
        .join("; ");
      return {
        ok: false,
        count: result.persistedCount,
        error,
        ms: elapsed(start),
      };
    }

    if (result.polymarketCount === 0 || result.kalshiCount === 0) {
      const error = `Insufficient market data (Polymarket=${result.polymarketCount}, Kalshi=${result.kalshiCount})`;
      console.error("[ev-pipeline] matchMarkets:", error);
      return { ok: false, count: 0, error, ms: elapsed(start) };
    }

    if (result.matchedCount === 0) {
      const matchFailure = result.failures.find((f) => f.stage === "match");
      const error =
        matchFailure?.message ??
        `No pairs matched above similarity threshold ${result.threshold} (PM=${result.polymarketCount}, Kalshi=${result.kalshiCount})`;
      console.warn("[ev-pipeline] matchMarkets:", error);
      return { ok: false, count: 0, error, ms: elapsed(start) };
    }

    const persistFailures = result.failures.filter((f) => f.stage === "persist");
    if (persistFailures.length > 0 && result.persistedCount === 0) {
      const error = persistFailures.map((f) => f.message).join("; ");
      console.error("[ev-pipeline] matchMarkets persist failures:", error);
      return { ok: false, count: 0, error, ms: elapsed(start) };
    }

    return {
      ok: true,
      count: result.persistedCount,
      ms: elapsed(start),
    };
  } catch (err) {
    console.error("MatchMarkets Error Details:", err);
    if (err instanceof Error) {
      console.error("[ev-pipeline] matchMarkets message:", err.message);
      if (err.stack) {
        console.error("[ev-pipeline] matchMarkets stack:", err.stack);
      }
      if ("cause" in err && err.cause) {
        console.error("[ev-pipeline] matchMarkets cause:", err.cause);
      }
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "matchMarkets failed",
      ms: elapsed(start),
    };
  }
}

/**
 * Stage 2.5 — Rebuild sportsbook consensus index with prop-level alias keys.
 */
export async function refreshConsensusIndexStage(): Promise<PipelineStageResult> {
  const start = Date.now();
  try {
    const result = await refreshConsensusIndex();
    logger.info(
      `[ev-pipeline] refreshConsensusIndex entries=${result.entryCount} prop_aliases=${result.propAliasCount}`
    );
    return {
      ok: true,
      count: result.entryCount + result.propAliasCount,
      ms: elapsed(start),
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "refreshConsensusIndex failed",
      ms: elapsed(start),
    };
  }
}

/**
 * Stage 2.75 — Warm RAG similar-market index + seed odds history from OB mids.
 */
export async function ingestRagContextStage(): Promise<PipelineStageResult> {
  const start = Date.now();
  try {
    const result = await ingestRagContext(activeMatchedPairs);
    logger.info(
      `[ev-pipeline] ingestRagContext similar=${result.similarMarketCount} odds_seeded=${result.oddsHistorySeeded}`
    );
    return {
      ok: true,
      count: result.similarMarketCount + result.oddsHistorySeeded,
      ms: elapsed(start),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "ingestRagContext failed",
      ms: elapsed(start),
    };
  }
}

/**
 * Stage 3 — pricing-engine p_true + cache trade EV at pm:{tokenId} / kalshi:{ticker}.
 * Ensemble probabilities are persisted to DB; Redis lookup EV uses lib/evPipeline/pricing.ts.
 */
export async function computePTrue(): Promise<PipelineStageResult> {
  const start = Date.now();
  if (!isDatabaseEnabled()) {
    return { ok: false, error: "DATABASE_URL not configured", ms: elapsed(start) };
  }

  try {
    const db = getDb();
    const computed = await processMappedPTrue(db, activeMatchedPairs);

    if (computed > 0) {
      logger.info(
        `[ev-pipeline] computePTrue processed ${computed} mapped pair(s)`
      );
    }

    try {
      const coverage = await collectPipelineCoverageReport(db);
      logger.info(formatPipelineCoverageSummary(coverage));
    } catch (coverageErr) {
      console.warn(
        "[ev-pipeline] coverage report failed:",
        coverageErr instanceof Error ? coverageErr.message : coverageErr
      );
    }

    return { ok: true, count: computed, ms: elapsed(start) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "computePTrue failed",
      ms: elapsed(start),
    };
  }
}

/**
 * Stage 3.5 — Precompute trade EV for recent whale-feed PM assets (deduped).
 */
export async function warmWhaleFeedEvStage(): Promise<PipelineStageResult> {
  const start = Date.now();
  try {
    const result = await warmWhaleFeedTradeEv();
    logger.info(
      `[ev-pipeline] warmWhaleFeedEv candidates=${result.candidates} warmed=${result.warmed} skipped=${result.skippedCached} errors=${result.errors}`
    );
    return {
      ok: result.errors === 0 || result.warmed > 0 || result.skippedCached > 0,
      count: result.warmed,
      ms: elapsed(start),
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "warmWhaleFeedEv failed",
      ms: elapsed(start),
    };
  }
}

/**
 * Stage 4 — Per-wallet average_ev + total_portfolio_ev from closed + open positions.
 */
export async function computeTraderEv(): Promise<PipelineStageResult> {
  const start = Date.now();
  if (!isDatabaseEnabled()) {
    return { ok: false, error: "DATABASE_URL not configured", ms: elapsed(start) };
  }

  try {
    // Wallet rollup not wired yet — always ensure per-trade lookup EV cache is complete.
    const db = getDb();
    const count =
      activeMatchedPairs.length > 0
        ? await ensureMappedTradeEvLookups(db, activeMatchedPairs)
        : 0;

    if (count > 0) {
      logger.info(
        `[ev-pipeline] computeTraderEv fallback cached trade EV for ${count} mapped pair(s)`
      );
    }

    return { ok: true, count, ms: elapsed(start) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "computeTraderEv failed",
      ms: elapsed(start),
    };
  }
}

export async function runEvPipeline(runId: string): Promise<EvPipelineResult> {
  initGlobalLocalEvCache();
  activeMatchedPairs = [];
  const ingestOrderBooksResult = await ingestOrderBooks();
  const matchMarketsResult = await matchMarkets();
  const refreshConsensusIndexResult = await refreshConsensusIndexStage();
  const ingestRagContextResult = await ingestRagContextStage();
  const computePTrueResult = await computePTrue();
  const warmWhaleFeedEvResult = await warmWhaleFeedEvStage();
  const computeTraderEvResult = await computeTraderEv();

  const stages = {
    ingestOrderBooks: ingestOrderBooksResult,
    matchMarkets: matchMarketsResult,
    refreshConsensusIndex: refreshConsensusIndexResult,
    ingestRagContext: ingestRagContextResult,
    computePTrue: computePTrueResult,
    warmWhaleFeedEv: warmWhaleFeedEvResult,
    computeTraderEv: computeTraderEvResult,
  };

  if (isDatabaseEnabled()) {
    try {
      const db = getDb();
      const counts: SyncRunCounts = {
        ingested: ingestOrderBooksResult.count,
        matched: matchMarketsResult.count,
        normalized: computePTrueResult.count,
        embedded: computeTraderEvResult.count,
      };
      await db.insert(syncRuns).values({
        scope: "all",
        status: Object.values(stages).every((s) => s.ok) ? "ok" : "error",
        finishedAt: new Date(),
        counts,
        error: Object.values(stages)
          .filter((s) => !s.ok)
          .map((s) => s.error)
          .filter(Boolean)
          .join("; ") || null,
      });
    } catch (error) {
      console.error("[DB WRITE ERROR]", error);
      throw error;
    }
  }

  void runId;
  return { runId, stages };
}

/** Helpers exported for unit tests / future stages. */
export const evPipelineTestExports = {
  cacheOrderBookMidBatch,
  cacheMappingBothWaysBatch,
  cachePTrue,
  cacheTraderEv,
  evRedisKeys,
  marketMappings,
  trueProbabilities,
  traderEvAnalytics,
  eq,
  processMappedPTrue,
  ensureMappedTradeEvLookups,
};
