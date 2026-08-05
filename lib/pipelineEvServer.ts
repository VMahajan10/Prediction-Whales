/**
 * In-process trade EV for Render workers and server runtimes.
 * Do not add `import "server-only"` — plain Node workers import this module.
 * Browser code must use `pipelineEvClient` (POST /api/ev/trades).
 */
import {
  createTimeoutPipelineTradeEv,
  createUnmappedPipelineTradeEv,
  ensureFullyComputedTradeEv,
  isFullyComputedTradeEv,
  loadMappingForTradeEv,
} from "@/lib/evPipeline/resolveTradeEv";
import { ENSEMBLE_LLM_TIMEOUT_MS } from "@/lib/evPipeline/ensemblePricingFallback";
import {
  enrichPipelineEvInputFromMapping,
  enrichPipelineTradeEvCrossIds,
  indexPipelineTradeEvAliases,
  normalizeKalshiTicker,
  normalizePmTokenId,
} from "@/lib/evPipeline/crossAssetLookup";
import {
  initGlobalLocalEvCache,
  seedPipelineLocalEvCache,
} from "@/lib/evPipeline/redisCache";
import type { PipelineTradeEv, PipelineTradeEvInput } from "@/lib/evPipeline/types";
import { pipelineEvLookupKey } from "@/lib/evPipeline/types";
import type { PipelineEvRequestItem } from "@/lib/types/ev";
import {
  normalizeIncomingTradePrice,
  normalizePipelineTradeEv,
  sealClientTradeEvPayload,
} from "@/lib/evPipeline/tradeEvRecord";
import { sleep } from "@/lib/kalshi/http";

initGlobalLocalEvCache();

const BATCH_CONCURRENCY = 3;
const BATCH_DELAY_MS = 250;

function toPipelineInput(item: PipelineEvRequestItem): PipelineTradeEvInput {
  return {
    source: item.source,
    tokenId: item.tokenId,
    kalshiTicker: item.kalshiTicker,
    tradePrice: item.tradePrice,
  };
}

function sealEntry(entry: PipelineTradeEv, lookupKey: string): PipelineTradeEv {
  return sealClientTradeEvPayload(
    enrichPipelineTradeEvCrossIds(entry, lookupKey),
    lookupKey
  );
}

function indexEntry(
  map: Map<string, PipelineTradeEv>,
  entry: PipelineTradeEv,
  lookupKey?: string
): void {
  const normalized = normalizePipelineTradeEv(entry, lookupKey ?? entry.key);
  if (normalized) {
    indexPipelineTradeEvAliases(map, normalized, lookupKey ?? entry.key);
  }
}

async function resolveOneServer(
  item: PipelineEvRequestItem,
  options?: { cacheOnly?: boolean }
): Promise<PipelineTradeEv> {
  const lookupKey = pipelineEvLookupKey(toPipelineInput(item));
  if (!lookupKey) {
    return createUnmappedPipelineTradeEv("unknown", toPipelineInput(item));
  }

  const tokenId = normalizePmTokenId(item.tokenId);
  const kalshiTicker = normalizeKalshiTicker(item.kalshiTicker);
  const mapping = await loadMappingForTradeEv(tokenId, kalshiTicker);
  const enriched = enrichPipelineEvInputFromMapping(toPipelineInput(item), mapping);

  try {
    const payload = await ensureFullyComputedTradeEv(
      lookupKey,
      enriched,
      mapping,
      options?.cacheOnly
        ? { cacheOnly: true }
        : { ensembleLlmTimeoutMs: ENSEMBLE_LLM_TIMEOUT_MS }
    );
    const sealed = sealEntry(payload, lookupKey);
    if (sealed.status === "ok") {
      seedPipelineLocalEvCache(lookupKey, sealed);
    }
    return sealed;
  } catch (err) {
    console.warn(
      "[pipelineEvServer] EV resolve failed — soft timeout payload",
      lookupKey,
      err instanceof Error ? err.message : err
    );
    return sealEntry(createTimeoutPipelineTradeEv(lookupKey, enriched), lookupKey);
  }
}

/** Direct in-process EV batch — Render worker path (no loopback HTTP to Vercel). */
export async function resolvePipelineEvBatchServer(
  items: PipelineEvRequestItem[]
): Promise<Map<string, PipelineTradeEv>> {
  const deduped = new Map<string, PipelineEvRequestItem>();
  for (const item of items) {
    const key = pipelineEvLookupKey(toPipelineInput(item));
    if (key) deduped.set(key, item);
  }

  if (deduped.size === 0) return new Map();

  const rows = Array.from(deduped.values());
  const phase1 = await Promise.all(
    rows.map((item) => resolveOneServer(item, { cacheOnly: true }))
  );

  const result = new Map<string, PipelineTradeEv>();
  const needsHydration: PipelineEvRequestItem[] = [];

  for (const payload of phase1) {
    const item = deduped.get(payload.key);
    if (!item) continue;

    const sealed = sealEntry(payload, payload.key);
    const executionPrice = normalizeIncomingTradePrice(item.tradePrice);
    if (isFullyComputedTradeEv(sealed, { executionPrice })) {
      indexEntry(result, sealed, payload.key);
      continue;
    }
    needsHydration.push(item);
  }

  for (let i = 0; i < needsHydration.length; i += BATCH_CONCURRENCY) {
    if (i > 0) await sleep(BATCH_DELAY_MS);
    const batch = needsHydration.slice(i, i + BATCH_CONCURRENCY);
    const hydrated = await Promise.all(batch.map((item) => resolveOneServer(item)));
    for (const payload of hydrated) {
      indexEntry(result, sealEntry(payload, payload.key), payload.key);
    }
  }

  return result;
}

/** Direct in-process single trade EV — Render worker path. */
export async function resolvePipelineTradeEvServer(
  item: PipelineEvRequestItem
): Promise<PipelineTradeEv | null> {
  const lookupKey = pipelineEvLookupKey(toPipelineInput(item));
  if (!lookupKey) return null;

  const cached = await resolveOneServer(item, { cacheOnly: true });
  const executionPrice = normalizeIncomingTradePrice(item.tradePrice);
  const sealedCached = sealEntry(cached, lookupKey);
  if (isFullyComputedTradeEv(sealedCached, { executionPrice })) {
    return sealedCached;
  }

  return resolveOneServer(item);
}
