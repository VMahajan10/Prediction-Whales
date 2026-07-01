import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { marketMappings } from "@/lib/crossmarket/store/schema";
import { cosineSimilarity, embedTexts } from "@/lib/evPipeline/embeddings";
import {
  validateMatchMarketsPreflight,
  formatPreflightErrors,
} from "@/lib/evPipeline/matchMarketsPreflight";
import {
  fetchAndNormalizeMarkets,
  type FetchMarketsOptions,
} from "@/lib/evPipeline/marketFetch";
import {
  bestCandidatePerPm,
  buildAllScoredPairs,
  extractContractTokens,
  greedyMatchFromPairs,
  type ContractTokens,
  type MatchScoreMethod,
} from "@/lib/evPipeline/matchTokens";
import {
  EvPipelineRedisWriteBatch,
  evRedisKeys,
  type CachedMapping,
} from "@/lib/evPipeline/redisCache";
import {
  matchSportsStructurePairs,
  mergeMatchedPairs,
} from "@/lib/evPipeline/sportsStructureMatch";
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  FALLBACK_SIMILARITY_THRESHOLD,
  MINIMUM_SIMILARITY_THRESHOLD,
  BROAD_SIMILARITY_THRESHOLD,
  type MapMarketsResult,
  type MatchedPair,
  type MappingFailure,
  type NormalizedMarketContract,
} from "@/lib/evPipeline/types";

export interface RunMarketMappingOptions extends FetchMarketsOptions {
  similarityThreshold?: number;
  /** When true (default), retry at FALLBACK_SIMILARITY_THRESHOLD if primary pass finds zero pairs. */
  allowThresholdFallback?: boolean;
  persist?: boolean;
}

function logTopMatchCandidates(
  polymarket: NormalizedMarketContract[],
  kalshi: NormalizedMarketContract[],
  ranked: ReturnType<typeof bestCandidatePerPm>,
  appliedThreshold: number
): void {
  const top = ranked.slice(0, 3);
  if (top.length === 0) {
    console.log("[ev/map-markets] Top match candidates: none computed");
    return;
  }

  console.log(
    `[ev/map-markets] Top ${top.length} match candidates (threshold=${appliedThreshold}, scores=adjusted):`
  );
  for (let idx = 0; idx < top.length; idx++) {
    const row = top[idx];
    const pm = polymarket[row.pmIndex];
    const km = kalshi[row.kalshiIndex];
    console.log(
      `[ev/map-markets] #${idx + 1} adjusted=${row.adjustedScore.toFixed(4)} raw=${row.rawScore.toFixed(4)} method=${row.method} PM="${pm.title}" ↔ Kalshi="${km.title}"`
    );
  }
}

async function persistMatches(
  matches: MatchedPair[],
  polymarket: NormalizedMarketContract[],
  kalshi: NormalizedMarketContract[],
  failures: MappingFailure[]
): Promise<number> {
  if (!isDatabaseEnabled()) {
    failures.push({
      stage: "persist",
      message: "DATABASE_URL is not configured — matches not saved",
    });
    console.error("[ev/map-markets] Persist skipped: DATABASE_URL missing");
    return 0;
  }

  const db = getDb();
  let persisted = 0;
  const redisBatch = new EvPipelineRedisWriteBatch();

  const pmByToken = new Map(
    polymarket.map((m) => [m.tokenOrTicker.toLowerCase(), m])
  );
  const kalshiByTicker = new Map(
    kalshi.map((m) => [m.tokenOrTicker.toUpperCase(), m])
  );

  for (const match of matches) {
    const matchMethod =
      match.matchMethod === "sports_structure"
        ? "deterministic"
        : (match.matchMethod ?? "vector");
    try {
      await db
        .insert(marketMappings)
        .values({
          polymarketTokenId: match.polymarketTokenId.toLowerCase(),
          polymarketConditionId: match.polymarketConditionId ?? null,
          kalshiTicker: match.kalshiTicker.toUpperCase(),
          confidenceScore: match.similarity,
          matchMethod,
          embeddingSimilarity: match.rawSimilarity ?? match.similarity,
          orientation: "same",
          pmOutcome: "Yes",
          kalshiOutcome: "yes",
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            marketMappings.polymarketTokenId,
            marketMappings.kalshiTicker,
          ],
          set: {
            confidenceScore: match.similarity,
            embeddingSimilarity: match.rawSimilarity ?? match.similarity,
            matchMethod,
            polymarketConditionId: match.polymarketConditionId ?? null,
            updatedAt: new Date(),
          },
        });

      const cached: CachedMapping = {
        polymarketTokenId: match.polymarketTokenId.toLowerCase(),
        kalshiTicker: match.kalshiTicker.toUpperCase(),
        confidenceScore: match.similarity,
        orientation: "same",
        matchMethod,
      };
      redisBatch.queueMappingBothWays(cached);

      const pmContract = pmByToken.get(match.polymarketTokenId.toLowerCase());
      const kalshiContract = kalshiByTicker.get(match.kalshiTicker.toUpperCase());
      const pmMid = midFromContract(pmContract);
      const kalshiMid = midFromContract(kalshiContract);

      if (pmMid != null) {
        redisBatch.queueOrderBookMid(
          evRedisKeys.orderBookPm(match.polymarketTokenId.toLowerCase()),
          {
            bid: pmContract?.yesBid ?? pmMid,
            ask: pmContract?.yesAsk ?? pmMid,
            mid: pmMid,
            ts: Date.now(),
          }
        );
      }

      if (kalshiMid != null) {
        redisBatch.queueOrderBookMid(
          evRedisKeys.orderBookKalshi(match.kalshiTicker.toUpperCase()),
          {
            bid: kalshiContract?.yesBid ?? kalshiMid,
            ask: kalshiContract?.yesAsk ?? kalshiMid,
            mid: kalshiMid,
            ts: Date.now(),
          }
        );
      }

      persisted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Insert failed";
      failures.push({
        stage: "persist",
        message,
        polymarketTokenId: match.polymarketTokenId,
        kalshiTicker: match.kalshiTicker,
      });
      console.error(
        `[ev/map-markets] Failed to persist mapping ${match.polymarketTokenId} ↔ ${match.kalshiTicker}:`,
        message
      );
    }
  }

  try {
    await redisBatch.flush();
  } catch (flushErr) {
    console.warn(
      "[ev/map-markets] Redis cache flush failed:",
      flushErr instanceof Error ? flushErr.message : flushErr
    );
  }

  return persisted;
}

function toMatchedPairs(
  rows: Array<{ pair: MatchedPair; method: MatchScoreMethod }>
): MatchedPair[] {
  return rows.map(({ pair, method }) => ({
    ...pair,
    matchMethod: method,
  }));
}

function runThresholdPass(
  allPairs: ReturnType<typeof buildAllScoredPairs>,
  polymarket: NormalizedMarketContract[],
  kalshi: NormalizedMarketContract[],
  threshold: number,
  pmTokens: ContractTokens[],
  kalshiTokens: ContractTokens[],
  requireTokenEvidence = false
): MatchedPair[] {
  return toMatchedPairs(
    greedyMatchFromPairs(allPairs, threshold, polymarket, kalshi, {
      pmTokens,
      kalshiTokens,
      requireTokenEvidence,
    })
  );
}

export async function runMarketMapping(
  options: RunMarketMappingOptions = {}
): Promise<MapMarketsResult> {
  const startedAt = Date.now();
  const primaryThreshold =
    options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const allowFallback = options.allowThresholdFallback !== false;
  let appliedThreshold = primaryThreshold;
  const failures: MappingFailure[] = [];
  let matches: MatchedPair[] = [];

  try {
    const preflight = validateMatchMarketsPreflight({
      persist: options.persist,
    });
    if (preflight.warnings.length > 0) {
      for (const warning of preflight.warnings) {
        console.warn(`[ev/map-markets] ${warning}`);
      }
    }
    if (!preflight.ok) {
      const message = formatPreflightErrors(preflight);
      console.error("[ev/map-markets] Preflight failed:", preflight.errors);
      failures.push({ stage: "embed", message });
      return {
        ok: false,
        polymarketCount: 0,
        kalshiCount: 0,
        embeddedCount: 0,
        matchedCount: 0,
        persistedCount: 0,
        threshold: appliedThreshold,
        failures,
        matches,
        durationMs: Date.now() - startedAt,
      };
    }

    console.info("[ev/map-markets] Fetching Polymarket + Kalshi markets…");
    const fetched = await fetchAndNormalizeMarkets(options);
    failures.push(...fetched.failures);

    const fetchedPmCount = fetched.polymarket.length;
    const fetchedKalshiCount = fetched.kalshi.length;

    const polymarketMarkets = fetched.polymarket;
    const kalshiMarkets = fetched.kalshi;

    console.info(
      `[ev/map-markets] Evaluating full market set: PM ${polymarketMarkets.length}, Kalshi ${kalshiMarkets.length} (${polymarketMarkets.length * kalshiMarkets.length} pair matrix)`
    );

    const sportsStructureMatches = matchSportsStructurePairs(
      polymarketMarkets,
      kalshiMarkets
    );
    console.info(
      `[ev/map-markets] Sports structure pass (pre-embedding): ${sportsStructureMatches.length} pairs`
    );

    if (polymarketMarkets.length === 0 || kalshiMarkets.length === 0) {
      const emptySide =
        polymarketMarkets.length === 0 && kalshiMarkets.length === 0
          ? "both platforms returned 0 markets"
          : polymarketMarkets.length === 0
            ? "Polymarket returned 0 markets"
            : "Kalshi returned 0 markets";
      console.error(`[ev/map-markets] Aborting match stage: ${emptySide}`, {
        failures: fetched.failures,
      });
      return {
        ok: false,
        polymarketCount: fetchedPmCount,
        kalshiCount: fetchedKalshiCount,
        embeddedCount: 0,
        matchedCount: 0,
        persistedCount: 0,
        threshold: appliedThreshold,
        failures,
        matches,
        durationMs: Date.now() - startedAt,
      };
    }

    const pmTokens = polymarketMarkets.map(extractContractTokens);
    const kalshiTokens = kalshiMarkets.map(extractContractTokens);

    console.info(
      `[ev/map-markets] Token pre-filter: PM avg ${avgTokenCount(pmTokens)} tokens, Kalshi avg ${avgTokenCount(kalshiTokens)} tokens`
    );

    const allTexts = [
      ...polymarketMarkets.map((m) => m.embeddingText),
      ...kalshiMarkets.map((m) => m.embeddingText),
    ];

    console.info(
      `[ev/map-markets] Embedding ${allTexts.length} contract texts (model text-embedding-3-small)…`
    );
    const embedded = await embedTexts(allTexts);
    failures.push(...embedded.failures);

    if (embedded.failures.length > 0) {
      console.error(
        "[ev/map-markets] Embedding failures:",
        embedded.failures.map((f) => f.message)
      );
    }

    if (embedded.vectors.length !== allTexts.length) {
      console.error(
        `[ev/map-markets] Embedding count mismatch: expected ${allTexts.length}, got ${embedded.vectors.length}`
      );
      return {
        ok: false,
        polymarketCount: fetchedPmCount,
        kalshiCount: fetchedKalshiCount,
        embeddedCount: embedded.vectors.length,
        matchedCount: 0,
        persistedCount: 0,
        threshold: appliedThreshold,
        failures,
        matches,
        durationMs: Date.now() - startedAt,
      };
    }

    const pmVectors = embedded.vectors.slice(0, polymarketMarkets.length);
    const kalshiVectors = embedded.vectors.slice(polymarketMarkets.length);

    const allPairs = buildAllScoredPairs(
      pmVectors,
      kalshiVectors,
      pmTokens,
      kalshiTokens,
      cosineSimilarity
    );
    const rankedPerPm = bestCandidatePerPm(allPairs);

    matches = runThresholdPass(
      allPairs,
      polymarketMarkets,
      kalshiMarkets,
      primaryThreshold,
      pmTokens,
      kalshiTokens
    );
    appliedThreshold = primaryThreshold;

    console.info(
      `[ev/map-markets] Primary pass (threshold=${primaryThreshold}, token-adjusted): ${matches.length} pairs`
    );

    if (
      matches.length === 0 &&
      allowFallback &&
      primaryThreshold > FALLBACK_SIMILARITY_THRESHOLD
    ) {
      console.warn(
        `[ev/map-markets] Zero matches at ${primaryThreshold}; retrying at fallback threshold ${FALLBACK_SIMILARITY_THRESHOLD}`
      );
      appliedThreshold = FALLBACK_SIMILARITY_THRESHOLD;
      matches = runThresholdPass(
        allPairs,
        polymarketMarkets,
        kalshiMarkets,
        appliedThreshold,
        pmTokens,
        kalshiTokens
      );
      console.info(
        `[ev/map-markets] Fallback pass (threshold=${appliedThreshold}): ${matches.length} pairs`
      );
    }

    if (
      matches.length === 0 &&
      allowFallback &&
      appliedThreshold > MINIMUM_SIMILARITY_THRESHOLD
    ) {
      console.warn(
        `[ev/map-markets] Zero matches at ${appliedThreshold}; retrying at minimum threshold ${MINIMUM_SIMILARITY_THRESHOLD}`
      );
      appliedThreshold = MINIMUM_SIMILARITY_THRESHOLD;
      matches = runThresholdPass(
        allPairs,
        polymarketMarkets,
        kalshiMarkets,
        appliedThreshold,
        pmTokens,
        kalshiTokens,
        false
      );
      console.info(
        `[ev/map-markets] Minimum pass (threshold=${appliedThreshold}): ${matches.length} pairs`
      );
    }

    if (
      allowFallback &&
      appliedThreshold > BROAD_SIMILARITY_THRESHOLD
    ) {
      console.warn(
        `[ev/map-markets] Broadening to threshold ${BROAD_SIMILARITY_THRESHOLD} for additional coverage (${matches.length} pairs so far)`
      );
      appliedThreshold = BROAD_SIMILARITY_THRESHOLD;
      const broadMatches = runThresholdPass(
        allPairs,
        polymarketMarkets,
        kalshiMarkets,
        appliedThreshold,
        pmTokens,
        kalshiTokens,
        false
      );
      if (broadMatches.length > matches.length) {
        matches = broadMatches;
      }
      console.info(
        `[ev/map-markets] Broad pass (threshold=${appliedThreshold}): ${matches.length} pairs`
      );
    }

    matches = mergeMatchedPairs(sportsStructureMatches, matches);
    console.info(
      `[ev/map-markets] Combined sports + vector matches: ${matches.length} pairs`
    );

    logTopMatchCandidates(
      polymarketMarkets,
      kalshiMarkets,
      rankedPerPm,
      appliedThreshold
    );

    if (matches.length === 0 && rankedPerPm.length > 0) {
      const best = rankedPerPm[0];
      failures.push({
        stage: "match",
        message: `No pairs matched above similarity threshold ${appliedThreshold} (best adjusted=${best.adjustedScore.toFixed(4)}, raw=${best.rawScore.toFixed(4)}, method=${best.method})`,
      });
    }

    let persistedCount = 0;
    if (options.persist !== false && matches.length > 0) {
      persistedCount = await persistMatches(
        matches,
        polymarketMarkets,
        kalshiMarkets,
        failures
      );
      console.info(`[ev/map-markets] Persisted ${persistedCount} mappings`);
    }

    const criticalFailures = failures.filter(
      (f) =>
        f.stage === "fetch_polymarket" ||
        f.stage === "fetch_kalshi" ||
        f.stage === "embed"
    );
    return {
      ok:
        criticalFailures.length === 0 &&
        matches.length > 0 &&
        (options.persist === false || persistedCount > 0),
      polymarketCount: fetchedPmCount,
      kalshiCount: fetchedKalshiCount,
      embeddedCount: embedded.vectors.length,
      matchedCount: matches.length,
      persistedCount,
      threshold: appliedThreshold,
      failures,
      matches,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    console.error("MatchMarkets Error Details:", err);
    if (err instanceof Error && err.stack) {
      console.error("[ev/map-markets] stack:", err.stack);
    }
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ stage: "match", message });
    return {
      ok: false,
      polymarketCount: 0,
      kalshiCount: 0,
      embeddedCount: 0,
      matchedCount: 0,
      persistedCount: 0,
      threshold: appliedThreshold,
      failures,
      matches,
      durationMs: Date.now() - startedAt,
    };
  }
}

function avgTokenCount(tokens: Array<{ numbers: string[]; keywords: string[] }>): string {
  if (tokens.length === 0) return "0";
  const avg =
    tokens.reduce((sum, t) => sum + t.numbers.length + t.keywords.length, 0) /
    tokens.length;
  return avg.toFixed(1);
}

function midFromContract(
  contract: NormalizedMarketContract | undefined
): number | null {
  if (!contract) return null;
  if (contract.impliedProbability != null) return contract.impliedProbability;
  if (contract.yesBid != null && contract.yesAsk != null) {
    return (contract.yesBid + contract.yesAsk) / 2;
  }
  if (contract.yesBid != null) return contract.yesBid;
  if (contract.yesAsk != null) return contract.yesAsk;
  return null;
}

/** Exported for tests. */
export { cosineSimilarity };
export {
  extractContractTokens,
  adjustSimilarityWithTokens,
} from "@/lib/evPipeline/matchTokens";
