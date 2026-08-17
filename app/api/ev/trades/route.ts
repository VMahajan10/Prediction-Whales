import { NextRequest, NextResponse } from "next/server";
import {
  createUnmappedPipelineTradeEv,
  ensureFullyComputedTradeEv,
  isFullyComputedTradeEv,
  loadMappingForTradeEv,
  type PipelineTradeEvInput,
} from "@/lib/evPipeline/resolveTradeEv";
import { ENSEMBLE_LLM_TIMEOUT_MS } from "@/lib/evPipeline/ensemblePricingFallback";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { normalizePipelineLookupKey } from "@/lib/evPipeline/types";
import {
  mergeLocalEvCache,
  initGlobalLocalEvCache,
  seedPipelineLocalEvCache,
  type CachedMapping,
} from "@/lib/evPipeline/redisCache";
import {
  enrichPipelineEvInputFromMapping,
  expandPipelineEvByKey,
  enrichPipelineTradeEvCrossIds,
  normalizeKalshiTicker,
  normalizePmTokenId,
} from "@/lib/evPipeline/crossAssetLookup";
import {
  normalizeIncomingTradePrice,
  sealClientTradeEvPayload,
} from "@/lib/evPipeline/tradeEvRecord";
import { sleep } from "@/lib/kalshi/http";

initGlobalLocalEvCache();

export const dynamic = "force-dynamic";

/** Max trades resolved in parallel per wave — caps concurrent LLM calls. */
const TRADE_EV_BATCH_CONCURRENCY = 3;
/** Pause between waves so OpenAI TPM limits are not exhausted. */
const TRADE_EV_BATCH_DELAY_MS = 250;
/** Mapping prefetch can run slightly wider — no LLM on this path. */
const MAPPING_PREFETCH_CONCURRENCY = 5;

interface TradeEvRequestItem {
  source: "polymarket" | "kalshi";
  tokenId?: string;
  asset?: string;
  kalshiTicker?: string;
  ticker?: string;
  tradePrice?: number;
  price?: number;
  currentPrice?: number;
}

function extractRawTokenId(item: TradeEvRequestItem): string | undefined {
  return (item.tokenId ?? item.asset)?.trim();
}

function normalizeBarePmTokenId(raw: string): string {
  return raw.trim().replace(/^pm:/i, "").toLowerCase();
}

/** Canonical pm:{tokenId} / kalshi:{ticker} key for cache and store lookups. */
function resolveLookupKey(item: TradeEvRequestItem): string | null {
  const source = item.source;
  if (source !== "polymarket" && source !== "kalshi") return null;

  if (source === "polymarket") {
    const rawTokenId = extractRawTokenId(item);
    if (!rawTokenId) return null;
    const lookupKey = rawTokenId.toLowerCase().startsWith("pm:")
      ? rawTokenId
      : `pm:${rawTokenId}`;
    return normalizePipelineLookupKey(lookupKey, "polymarket");
  }

  const rawTicker = (item.kalshiTicker ?? item.ticker)?.trim();
  if (!rawTicker) return null;
  const lookupKey = rawTicker.toLowerCase().startsWith("kalshi:")
    ? rawTicker
    : `kalshi:${rawTicker}`;
  return normalizePipelineLookupKey(lookupKey, "kalshi");
}

function normalizeItem(item: TradeEvRequestItem): PipelineTradeEvInput | null {
  const source = item.source;
  if (source !== "polymarket" && source !== "kalshi") return null;

  const tradePrice =
    item.tradePrice ?? item.price ?? item.currentPrice;

  const rawTokenId = extractRawTokenId(item);

  return {
    source,
    tokenId: rawTokenId ? normalizeBarePmTokenId(rawTokenId) : undefined,
    kalshiTicker: (item.kalshiTicker ?? item.ticker)?.trim(),
    tradePrice,
  };
}

function sealTradeEvResponse(
  entry: PipelineTradeEv,
  lookupKey: string,
  executionPrice?: number | null
): PipelineTradeEv {
  const normalizeOptions =
    executionPrice != null ? { executionPrice } : undefined;
  return sealClientTradeEvPayload(
    enrichPipelineTradeEvCrossIds(entry, lookupKey),
    lookupKey,
    normalizeOptions
  );
}

function logSamplePayload(responseData: {
  entries: PipelineTradeEv[];
  byKey: Record<string, PipelineTradeEv>;
}): void {
  try {
    const sampleKey = Object.keys(responseData.byKey)[0];
    if (sampleKey) {
      console.log(
        "Final Sent Payload Sample:",
        responseData.byKey[sampleKey]
      );
      return;
    }
    if (responseData.entries[0]) {
      console.log("Final Sent Payload Sample:", responseData.entries[0]);
    }
  } catch {
    // Non-fatal debug logging.
  }
}

async function enrichBatchItemsFromMappings(
  items: Map<string, { item: PipelineTradeEvInput; lookupKey: string }>
): Promise<
  Map<
    string,
    { item: PipelineTradeEvInput; lookupKey: string; mapping: CachedMapping | null }
  >
> {
  const enriched = new Map<
    string,
    { item: PipelineTradeEvInput; lookupKey: string; mapping: CachedMapping | null }
  >();

  const rows = Array.from(items.entries());
  for (let i = 0; i < rows.length; i += MAPPING_PREFETCH_CONCURRENCY) {
    if (i > 0) await sleep(TRADE_EV_BATCH_DELAY_MS);
    const batch = rows.slice(i, i + MAPPING_PREFETCH_CONCURRENCY);
    await Promise.all(
      batch.map(async ([lookupKey, row]) => {
        const tokenId = normalizePmTokenId(row.item.tokenId);
        const kalshiTicker = normalizeKalshiTicker(row.item.kalshiTicker);
        const mapping = await loadMappingForTradeEv(tokenId, kalshiTicker);

        enriched.set(lookupKey, {
          lookupKey,
          mapping,
          item: enrichPipelineEvInputFromMapping(row.item, mapping),
        });
      })
    );
  }

  return enriched;
}

type EnrichedTradeEvRow = {
  item: PipelineTradeEvInput;
  lookupKey: string;
  mapping: CachedMapping | null;
};

async function resolveTradeEvBatch(
  rows: EnrichedTradeEvRow[]
): Promise<PipelineTradeEv[]> {
  const hydrateOptions = { ensembleLlmTimeoutMs: ENSEMBLE_LLM_TIMEOUT_MS };

  const phase1 = await Promise.all(
    rows.map(async (row) => {
      const { lookupKey, item, mapping } = row;
      try {
        const payload = await ensureFullyComputedTradeEv(
          lookupKey,
          item,
          mapping,
          { cacheOnly: true }
        );
        return { row, payload };
      } catch {
        return {
          row,
          payload: createUnmappedPipelineTradeEv(lookupKey, item),
        };
      }
    })
  );

  const resolved: PipelineTradeEv[] = [];

  for (let i = 0; i < phase1.length; i += TRADE_EV_BATCH_CONCURRENCY) {
    if (i > 0) await sleep(TRADE_EV_BATCH_DELAY_MS);
    const batch = phase1.slice(i, i + TRADE_EV_BATCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async ({ row, payload }) => {
        const { lookupKey, item, mapping } = row;
        const executionPrice = normalizeIncomingTradePrice(item.tradePrice);
        const sealedPartial = sealTradeEvResponse(
          payload,
          lookupKey,
          executionPrice
        );
        if (
          isFullyComputedTradeEv(sealedPartial, { executionPrice })
        ) {
          if (sealedPartial.status === "ok") {
            seedPipelineLocalEvCache(lookupKey, sealedPartial);
          }
          return sealedPartial;
        }

        try {
          const hydrated = await ensureFullyComputedTradeEv(
            lookupKey,
            item,
            mapping,
            hydrateOptions
          );
          const sealed = sealTradeEvResponse(
            hydrated,
            lookupKey,
            executionPrice
          );
          if (sealed.status === "ok") {
            seedPipelineLocalEvCache(lookupKey, sealed);
          }
          return sealed;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("Batch EV Fetch Error:", message);
          return sealedPartial;
        }
      })
    );
    resolved.push(...batchResults);
  }

  return resolved;
}

function collectUniqueBatchItems(
  rawItems: TradeEvRequestItem[]
): Map<string, { item: PipelineTradeEvInput; lookupKey: string }> {
  const draft = new Map<
    string,
    { item: PipelineTradeEvInput; lookupKey: string }
  >();

  for (const rawItem of rawItems) {
    const item = normalizeItem(rawItem);
    if (!item) continue;

    const lookupKey = resolveLookupKey(rawItem);
    if (!lookupKey) continue;

    const itemPrice = normalizeIncomingTradePrice(item.tradePrice);
    const existing = draft.get(lookupKey);
    const existingPrice = existing
      ? normalizeIncomingTradePrice(existing.item.tradePrice)
      : undefined;
    if (!existing || (itemPrice != null && existingPrice == null)) {
      draft.set(lookupKey, { item, lookupKey });
    }
  }

  return draft;
}

export async function POST(request: NextRequest) {
  const entries: PipelineTradeEv[] = [];
  const byKey: Record<string, PipelineTradeEv> = {};

  try {
    let body: { items?: TradeEvRequestItem[] };
    try {
      body = (await request.json()) as { items?: TradeEvRequestItem[] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Batch EV Fetch Error:", message);
      return NextResponse.json({ entries, byKey }, { status: 200 });
    }

    const unique = await enrichBatchItemsFromMappings(
      collectUniqueBatchItems(body.items ?? [])
    );

    const resolved = await resolveTradeEvBatch(Array.from(unique.values()));
    for (const sealed of resolved) {
      byKey[sealed.key] = sealed;
      entries.push(sealed);
    }

    try {
      mergeLocalEvCache(byKey);
    } catch (mergeErr) {
      console.error(
        "Batch EV Fetch Error:",
        mergeErr instanceof Error ? mergeErr.message : mergeErr
      );
    }

    const expandedByKey = expandPipelineEvByKey(byKey);
    const responseData = {
      entries,
      byKey: expandedByKey,
    };
    logSamplePayload(responseData);
    return NextResponse.json(responseData, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Batch EV Fetch Error:", message);
    return NextResponse.json({ entries, byKey }, { status: 200 });
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const source = searchParams.get("source");
  if (source !== "polymarket" && source !== "kalshi") {
    return NextResponse.json(
      { error: "Provide source=polymarket|kalshi" },
      { status: 400 }
    );
  }

  const item = normalizeItem({
    source,
    tokenId: searchParams.get("tokenId") ?? searchParams.get("asset") ?? undefined,
    kalshiTicker:
      searchParams.get("kalshiTicker") ??
      searchParams.get("ticker") ??
      undefined,
    tradePrice: searchParams.get("price")
      ? Number(searchParams.get("price"))
      : undefined,
  });

  if (!item) {
    return NextResponse.json(
      { error: "Provide tokenId (PM) or kalshiTicker (Kalshi)" },
      { status: 400 }
    );
  }

  const lookupKey = resolveLookupKey({
    source,
    tokenId: searchParams.get("tokenId") ?? searchParams.get("asset") ?? undefined,
    kalshiTicker:
      searchParams.get("kalshiTicker") ??
      searchParams.get("ticker") ??
      undefined,
  });

  if (!lookupKey) {
    return NextResponse.json({ entry: null }, { status: 200 });
  }

  try {
    const enriched = await enrichBatchItemsFromMappings(
      collectUniqueBatchItems([
        {
          source,
          tokenId: searchParams.get("tokenId") ?? searchParams.get("asset") ?? undefined,
          kalshiTicker:
            searchParams.get("kalshiTicker") ??
            searchParams.get("ticker") ??
            undefined,
          tradePrice: searchParams.get("price")
            ? Number(searchParams.get("price"))
            : undefined,
        },
      ])
    );
    const row = enriched.get(lookupKey);
    const resolvedItem = row?.item ?? item;
    const resolvedMapping = row?.mapping ?? null;

    const entry = await ensureFullyComputedTradeEv(
      lookupKey,
      resolvedItem,
      resolvedMapping,
      { ensembleLlmTimeoutMs: ENSEMBLE_LLM_TIMEOUT_MS }
    );
    const executionPrice = normalizeIncomingTradePrice(resolvedItem.tradePrice);
    const enrichedEntry = sealTradeEvResponse(
      entry,
      lookupKey,
      executionPrice
    );
    if (enrichedEntry.status === "ok") {
      seedPipelineLocalEvCache(lookupKey, enrichedEntry);
    }
    console.log("Final Sent Payload Sample:", enrichedEntry);
    return NextResponse.json({ entry: enrichedEntry }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Batch EV Fetch Error:", message);
    return NextResponse.json(
      { entry: createUnmappedPipelineTradeEv(lookupKey, item) },
      { status: 200 }
    );
  }
}
