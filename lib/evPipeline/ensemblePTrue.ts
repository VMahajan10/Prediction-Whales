import { desc, eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { trueProbabilities } from "@/lib/crossmarket/store/schema";
import { normalizePmTokenId } from "@/lib/evPipeline/crossAssetLookup";
import { getPTrue } from "@/lib/evPipeline/redisCache";

export interface EnsemblePTrueMeta {
  sourceType?: string | null;
  sourceScore?: number | null;
}

/** Synthetic 50/50 rows should not beat live OB / sportsbook consensus. */
export function isPlaceholderEnsemblePTrue(
  pTrue: number | null | undefined,
  meta?: EnsemblePTrueMeta | null
): boolean {
  if (pTrue == null || !Number.isFinite(pTrue)) return true;

  const sourceType = (meta?.sourceType ?? "").trim().toLowerCase();
  if (
    sourceType === "universal_prior" ||
    sourceType === "execution_price"
  ) {
    return true;
  }

  const score = meta?.sourceScore;
  if (score != null && Number.isFinite(score) && score < 0.35) {
    return true;
  }

  if (
    Math.abs(pTrue - 0.5) <= 1e-6 &&
    (score == null || !Number.isFinite(score) || score < 0.5)
  ) {
    return true;
  }

  return false;
}

export function pickAuthoritativeEnsemblePTrue(
  pTrue: number | null | undefined,
  meta?: EnsemblePTrueMeta | null
): number | null {
  if (isPlaceholderEnsemblePTrue(pTrue, meta)) return null;
  return pTrue!;
}

/** Latest ensemble p_true row for a PM token (true_probabilities). */
export async function latestEnsemblePTrueFromDb(
  tokenId: string
): Promise<number | null> {
  const lookup = await latestEnsemblePTrueLookupFromDb(tokenId);
  return lookup?.pTrue ?? null;
}

export async function latestEnsemblePTrueLookupFromDb(
  tokenId: string
): Promise<{ pTrue: number; sourceType: string; sourceScore: number | null } | null> {
  if (!isDatabaseEnabled()) return null;
  try {
    const db = getDb();
    const rows = await db
      .select({
        pTrue: trueProbabilities.pTrue,
        sourceType: trueProbabilities.sourceType,
        sourceScore: trueProbabilities.sourceScore,
      })
      .from(trueProbabilities)
      .where(eq(trueProbabilities.polymarketTokenId, tokenId.toLowerCase()))
      .orderBy(desc(trueProbabilities.calculatedAt))
      .limit(1);
    const row = rows[0];
    if (!row?.pTrue) return null;
    const parsed = Number(row.pTrue);
    if (!Number.isFinite(parsed)) return null;
    const sourceScore =
      row.sourceScore != null ? Number(row.sourceScore) : null;
    if (isPlaceholderEnsemblePTrue(parsed, {
      sourceType: row.sourceType,
      sourceScore,
    })) {
      return null;
    }
    return {
      pTrue: parsed,
      sourceType: row.sourceType,
      sourceScore:
        sourceScore != null && Number.isFinite(sourceScore) ? sourceScore : null,
    };
  } catch {
    return null;
  }
}

/** Redis cache first, then Postgres ensemble row. */
export async function resolveEnsemblePTrue(
  tokenId: string | null | undefined
): Promise<number | null> {
  const lookup = await resolveEnsemblePTrueLookup(tokenId);
  return lookup?.pTrue ?? null;
}

export async function resolveEnsemblePTrueLookup(
  tokenId: string | null | undefined
): Promise<{ pTrue: number; sourceType: string; sourceScore: number | null } | null> {
  const pm = normalizePmTokenId(tokenId);
  if (!pm) return null;

  try {
    const cached = await getPTrue(pm);
    if (cached?.pTrue != null && Number.isFinite(cached.pTrue)) {
      const sourceScore =
        cached.sourceScore != null ? Number(cached.sourceScore) : null;
      const authoritative = pickAuthoritativeEnsemblePTrue(cached.pTrue, {
        sourceType: cached.sourceType,
        sourceScore,
      });
      if (authoritative != null) {
        return {
          pTrue: authoritative,
          sourceType: cached.sourceType,
          sourceScore:
            sourceScore != null && Number.isFinite(sourceScore)
              ? sourceScore
              : null,
        };
      }
    }
  } catch {
    // Fall through to DB.
  }

  return latestEnsemblePTrueLookupFromDb(pm);
}
