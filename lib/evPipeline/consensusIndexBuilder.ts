import {
  buildCrossMarketBookIndex,
  type OutcomeBooks,
} from "@/lib/crossMarketEv";
import {
  getCrossMarketEvIndex,
  type CachedEvIndexPayload,
  type SerializedEvIndexEntry,
} from "@/lib/crossMarketEvIndexStore";
import { enrichConsensusIndexWithPropKeys } from "@/lib/evPipeline/consensusIndexEnrich";
import { writeConsensusIndexPayload } from "@/lib/evPipeline/consensusIndexCache";

export { enrichConsensusIndexWithPropKeys } from "@/lib/evPipeline/consensusIndexEnrich";

export interface ConsensusIndexRefreshResult {
  entryCount: number;
  propAliasCount: number;
  generatedAt: string;
}

/** Force-rebuild the cross-market consensus index (sportsbook + prop aliases). */
export async function refreshConsensusIndex(): Promise<ConsensusIndexRefreshResult> {
  const baseIndex = await buildCrossMarketBookIndex();
  const enriched = enrichConsensusIndexWithPropKeys(baseIndex);

  const entries: SerializedEvIndexEntry[] = Array.from(enriched.entries()).map(
    ([id, entry]) => ({
      id,
      game: entry.game,
      outcome: entry.outcome,
      kalshi: entry.kalshi,
      polymarket: entry.polymarket,
      manifold: entry.manifold,
      sportsbook: entry.sportsbook,
      label: entry.label,
    })
  );

  const payload: CachedEvIndexPayload = {
    generatedAt: new Date().toISOString(),
    entries,
    cachedAt: Date.now(),
  };

  await writeConsensusIndexPayload(payload);

  return {
    entryCount: baseIndex.size,
    propAliasCount: enriched.size - baseIndex.size,
    generatedAt: payload.generatedAt,
  };
}

/** Read enriched index — uses cache when warm, otherwise enriches on read. */
export async function getEnrichedConsensusIndex(): Promise<
  Map<string, OutcomeBooks>
> {
  const cached = await getCrossMarketEvIndex();
  const base = new Map<string, OutcomeBooks>();
  for (const entry of cached.entries) {
    base.set(entry.id, {
      game: entry.game,
      outcome: entry.outcome,
      kalshi: entry.kalshi,
      polymarket: entry.polymarket,
      manifold: entry.manifold ?? null,
      sportsbook: entry.sportsbook,
      label: entry.label,
    });
  }
  return enrichConsensusIndexWithPropKeys(base);
}
