import { desc } from "drizzle-orm";
import type { getDb } from "@/lib/crossmarket/store/db";
import { trueProbabilities } from "@/lib/crossmarket/store/schema";
import type { SimilarMarketProfile } from "@/lib/ai/rag/types";

type Db = ReturnType<typeof getDb>;

const STOP_WORDS = new Set([
  "will",
  "the",
  "a",
  "an",
  "be",
  "by",
  "on",
  "in",
  "at",
  "to",
  "of",
  "for",
  "and",
  "or",
  "vs",
  "match",
  "winner",
  "game",
]);

let candidatePool: SimilarMarketProfile[] = [];

export function setSimilarMarketCandidates(
  profiles: SimilarMarketProfile[]
): void {
  candidatePool = profiles;
}

export function getSimilarMarketCandidates(): SimilarMarketProfile[] {
  return candidatePool;
}

export function clearSimilarMarketCandidates(): void {
  candidatePool = [];
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of Array.from(a)) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export function findSimilarMarkets(
  queryTitle: string,
  excludeTokenId?: string | null,
  limit = 3
): SimilarMarketProfile[] {
  const queryTokens = tokenize(queryTitle);
  if (queryTokens.size === 0) return [];

  const exclude = excludeTokenId?.trim().toLowerCase() ?? null;

  return candidatePool
    .filter((c) => !exclude || c.tokenId !== exclude)
    .map((candidate) => ({
      candidate,
      score: jaccardSimilarity(queryTokens, tokenize(candidate.title)),
    }))
    .filter((row) => row.score >= 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.candidate);
}

/**
 * Warm the in-memory similar-market index from recent DB rows.
 */
export async function loadSimilarMarketCandidatesFromDb(
  db: Db,
  rowLimit = 400
): Promise<number> {
  const rows = await db
    .select({
      tokenId: trueProbabilities.polymarketTokenId,
      kalshiTicker: trueProbabilities.kalshiTicker,
      pTrue: trueProbabilities.pTrue,
      sourceType: trueProbabilities.sourceType,
    })
    .from(trueProbabilities)
    .orderBy(desc(trueProbabilities.calculatedAt))
    .limit(rowLimit);

  const seen = new Set<string>();
  const profiles: SimilarMarketProfile[] = [];

  for (const row of rows) {
    const tokenId = row.tokenId.trim().toLowerCase();
    if (seen.has(tokenId)) continue;
    seen.add(tokenId);

    const title =
      row.kalshiTicker?.trim() ||
      tokenId;
    const pTrue = row.pTrue != null ? Number(row.pTrue) : null;

    profiles.push({
      tokenId,
      kalshiTicker: row.kalshiTicker,
      title,
      pTrue: Number.isFinite(pTrue) ? pTrue : null,
      pmMid: null,
      kalshiMid: null,
      sourceType: row.sourceType,
    });
  }

  setSimilarMarketCandidates(profiles);
  return profiles.length;
}
