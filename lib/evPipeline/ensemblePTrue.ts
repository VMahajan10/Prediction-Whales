import { desc, eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { trueProbabilities } from "@/lib/crossmarket/store/schema";
import { normalizePmTokenId } from "@/lib/evPipeline/crossAssetLookup";
import { getPTrue } from "@/lib/evPipeline/redisCache";

/** Latest ensemble p_true row for a PM token (true_probabilities). */
export async function latestEnsemblePTrueFromDb(
  tokenId: string
): Promise<number | null> {
  if (!isDatabaseEnabled()) return null;
  try {
    const db = getDb();
    const rows = await db
      .select({ pTrue: trueProbabilities.pTrue })
      .from(trueProbabilities)
      .where(eq(trueProbabilities.polymarketTokenId, tokenId.toLowerCase()))
      .orderBy(desc(trueProbabilities.calculatedAt))
      .limit(1);
    const raw = rows[0]?.pTrue;
    if (raw == null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Redis cache first, then Postgres ensemble row. */
export async function resolveEnsemblePTrue(
  tokenId: string | null | undefined
): Promise<number | null> {
  const pm = normalizePmTokenId(tokenId);
  if (!pm) return null;

  try {
    const cached = await getPTrue(pm);
    if (cached?.pTrue != null && Number.isFinite(cached.pTrue)) {
      return cached.pTrue;
    }
  } catch {
    // Fall through to DB.
  }

  return latestEnsemblePTrueFromDb(pm);
}
