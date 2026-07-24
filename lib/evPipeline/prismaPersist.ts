import type { Prisma } from "@prisma/client";
import { evPricingSignal } from "@/lib/crossMarketEvDisplay";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";
import type { MatchedPair } from "@/lib/evPipeline/types";

function confidenceTier(similarity: number): string {
  if (similarity >= 0.75) return "direct";
  if (similarity >= 0.62) return "correlated";
  return "proxy";
}

function resolveMatchMethod(match: MatchedPair): string {
  return match.matchMethod === "sports_structure"
    ? "deterministic"
    : (match.matchMethod ?? "vector");
}

async function ensureKalshiNormalizedId(
  kalshiTicker: string,
  kalshiTitle: string
): Promise<bigint> {
  const prisma = getPrisma();
  if (!prisma) {
    throw new Error("Prisma client is not configured");
  }

  const externalId = kalshiTicker.toUpperCase();
  const raw = await prisma.markets_raw.upsert({
    where: {
      platform_external_id: {
        platform: "kalshi",
        external_id: externalId,
      },
    },
    create: {
      platform: "kalshi",
      external_id: externalId,
      tier: 1,
      title: kalshiTitle,
      raw_payload: { source: "ev_pipeline" },
    },
    update: {
      title: kalshiTitle,
    },
  });

  const existing = await prisma.markets_normalized.findFirst({
    where: { raw_id: raw.id },
    select: { id: true },
  });
  if (existing) return existing.id;

  const normalized = await prisma.markets_normalized.create({
    data: {
      raw_id: raw.id,
      canonical_title: kalshiTitle,
      norm_method: "pipeline_v2",
    },
  });

  return normalized.id;
}

/** Persist a cross-platform match row (and link market_mappings when provided). */
export async function upsertMarketMatchPrisma(
  match: MatchedPair,
  options?: { mappingId?: number }
): Promise<bigint | null> {
  if (!isPrismaEnabled()) return null;

  const prisma = getPrisma();
  if (!prisma) return null;

  try {
    const normalizedId = await ensureKalshiNormalizedId(
      match.kalshiTicker,
      match.kalshiTitle
    );
    const polymarketId = match.polymarketTokenId.toLowerCase();
    const matchMethod = resolveMatchMethod(match);

    const row = await prisma.marketMatch.upsert({
      where: {
        polymarket_id_normalized_id: {
          polymarket_id: polymarketId,
          normalized_id: normalizedId,
        },
      },
      create: {
        polymarket_id: polymarketId,
        normalized_id: normalizedId,
        platform: "kalshi",
        pm_outcome: "Yes",
        contributor_outcome: "yes",
        orientation: "same",
        confidence_tier: confidenceTier(match.similarity),
        score: match.similarity,
        match_method: matchMethod,
      },
      update: {
        score: match.similarity,
        match_method: matchMethod,
        confidence_tier: confidenceTier(match.similarity),
      },
    });

    if (options?.mappingId != null && options.mappingId > 0) {
      await prisma.market_mappings.update({
        where: { id: BigInt(options.mappingId) },
        data: { market_match_id: row.id },
      });
    }

    return row.id;
  } catch (error) {
    console.error("[DB WRITE ERROR]", error);
    throw error;
  }
}

/** Append a historical EV snapshot for a Polymarket market. */
export async function createEvSnapshotPrisma(input: {
  polymarketTokenId: string;
  pmMid: number | null;
  consensusProb: number;
  contributors: Prisma.InputJsonValue;
  netEvPercent?: number | null;
}): Promise<void> {
  if (!isPrismaEnabled()) return;

  const prisma = getPrisma();
  if (!prisma) return;

  const pmProb = input.pmMid ?? 0;
  const consensus = input.consensusProb;
  const gap = consensus - pmProb;
  const evPercent =
    input.netEvPercent ??
    (pmProb > 0 ? (gap / pmProb) * 100 : gap * 100);
  const signal = evPricingSignal(evPercent);

  try {
    await prisma.evSnapshot.create({
      data: {
        polymarket_id: input.polymarketTokenId.toLowerCase(),
        polymarket_prob: pmProb,
        consensus_prob: consensus,
        gap,
        signal,
        contributors: input.contributors,
      },
    });
  } catch (error) {
    console.error("[DB WRITE ERROR]", error);
    throw error;
  }
}
