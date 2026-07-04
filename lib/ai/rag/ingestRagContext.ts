import { isDatabaseEnabled, getDb } from "@/lib/crossmarket/store/db";
import {
  getSimilarMarketCandidates,
  loadSimilarMarketCandidatesFromDb,
  setSimilarMarketCandidates,
} from "@/lib/ai/rag/similarMarketIndex";
import type { SimilarMarketProfile } from "@/lib/ai/rag/types";
import type { MatchedPair } from "@/lib/evPipeline/types";
import { appendOddsHistory } from "@/lib/ai/rag/oddsHistoryStore";
import {
  execRedisReadPipeline,
  evRedisKeys,
  type CachedOrderBookMid,
} from "@/lib/evPipeline/redisCache";

export interface IngestRagContextResult {
  similarMarketCount: number;
  oddsHistorySeeded: number;
}

/**
 * Pipeline stage helper — warm similar-market index and seed odds history from OB mids.
 */
export async function ingestRagContext(
  matchedPairs: MatchedPair[] = []
): Promise<IngestRagContextResult> {
  let similarMarketCount = 0;
  const pairProfiles: SimilarMarketProfile[] = matchedPairs.map((pair) => ({
    tokenId: pair.polymarketTokenId.toLowerCase(),
    kalshiTicker: pair.kalshiTicker,
    title: pair.polymarketTitle || pair.kalshiTitle,
    pTrue: pair.pTrue ?? null,
    pmMid: null,
    kalshiMid: null,
    sourceType: pair.matchMethod ?? null,
  }));

  if (isDatabaseEnabled()) {
    try {
      const db = getDb();
      similarMarketCount = await loadSimilarMarketCandidatesFromDb(db);
    } catch (err) {
      console.warn(
        "[rag/ingest] similar market load failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  if (pairProfiles.length > 0) {
    const merged = new Map<string, SimilarMarketProfile>();
    for (const profile of pairProfiles) {
      merged.set(profile.tokenId, profile);
    }
    for (const profile of getSimilarMarketCandidates()) {
      if (!merged.has(profile.tokenId)) {
        merged.set(profile.tokenId, profile);
      }
    }
    setSimilarMarketCandidates(Array.from(merged.values()));
    similarMarketCount = merged.size;
  }

  let oddsHistorySeeded = 0;
  if (matchedPairs.length === 0) {
    return { similarMarketCount, oddsHistorySeeded };
  }

  const tokenIds = matchedPairs.map((p) =>
    p.polymarketTokenId.toLowerCase()
  );
  const obKeys = tokenIds.map((id) => evRedisKeys.orderBookPm(id));
  const obMap = await execRedisReadPipeline(obKeys);

  const now = new Date().toISOString();

  for (const pair of matchedPairs) {
    const tokenId = pair.polymarketTokenId.toLowerCase();
    const pmOb = obMap.get(evRedisKeys.orderBookPm(tokenId)) as
      | CachedOrderBookMid
      | undefined;
    const pmMid = pmOb?.mid ?? null;
    const kalshiMid = null;
    const marketPrior = pmMid ?? 0.5;

    await appendOddsHistory(tokenId, {
      ts: now,
      pmMid,
      kalshiMid,
      marketPrior,
      pTrue: null,
    });
    oddsHistorySeeded += 1;
  }

  return { similarMarketCount, oddsHistorySeeded };
}
