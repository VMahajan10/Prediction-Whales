import { NextRequest, NextResponse } from "next/server";
import {
  buildDynamicBaselineTradeEv,
  createUnmappedPipelineTradeEv,
  resolvePipelineTradeEv,
  type PipelineTradeEvInput,
} from "@/lib/evPipeline/resolveTradeEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { normalizePipelineLookupKey } from "@/lib/evPipeline/types";
import {
  mergeLocalEvCache,
  readLocalTradeEvLookup,
  initGlobalLocalEvCache,
  seedPipelineLocalEvCache,
  getTradeEvLookupRedisOnly,
  prefetchMappingsByKalshiTickers,
  prefetchMappingsByPmTokenIds,
} from "@/lib/evPipeline/redisCache";
import {
  enrichPipelineEvInputFromMapping,
  expandPipelineEvByKey,
  normalizeKalshiTicker,
  normalizePmTokenId,
} from "@/lib/evPipeline/crossAssetLookup";
import {
  normalizeIncomingTradePrice,
  normalizePipelineTradeEv,
  strictApiTradeEvPayload,
} from "@/lib/evPipeline/tradeEvRecord";

initGlobalLocalEvCache();

export const dynamic = "force-dynamic";

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

function mapApiTradeEvPayload(
  item: PipelineTradeEv,
  lookupKey: string
): PipelineTradeEv {
  const normalized = normalizePipelineTradeEv(item, lookupKey) ?? item;
  const payload = strictApiTradeEvPayload(normalized, lookupKey);
  if (payload.status === "ok" && payload.netEvPercent === 0) {
    console.log("⚠️ [Backend Zero EV]", {
      lookupKey,
      pmMid: payload.pMarket,
      kalshiMid: undefined,
      pTrue: payload.pTrue,
      netEvPercent: payload.netEvPercent,
    });
  }
  return payload;
}

function safeMapApiTradeEvPayload(
  item: PipelineTradeEv,
  lookupKey: string
): PipelineTradeEv {
  try {
    return mapApiTradeEvPayload(item, lookupKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Batch EV Fetch Error:", message);
    return createUnmappedPipelineTradeEv(lookupKey);
  }
}

function isCachedOkPayload(payload: PipelineTradeEv): boolean {
  return (
    payload.status === "ok" &&
    payload.netEvPercent !== null &&
    payload.netEvPercent !== undefined
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

async function resolveBatchTradeEv(
  lookupKey: string,
  item: PipelineTradeEvInput
): Promise<PipelineTradeEv> {
  try {
    const storeHit = await getTradeEvLookupRedisOnly(lookupKey);
    if (storeHit) {
      const payload = safeMapApiTradeEvPayload(storeHit, lookupKey);
      if (isCachedOkPayload(payload)) {
        seedPipelineLocalEvCache(lookupKey, payload);
        return payload;
      }
    }

    try {
      const row = await resolvePipelineTradeEv(item);
      if (row) {
        const resolvedPayload = safeMapApiTradeEvPayload(row, lookupKey);
        if (isCachedOkPayload(resolvedPayload)) {
          seedPipelineLocalEvCache(lookupKey, resolvedPayload);
          return resolvedPayload;
        }
      }
    } catch (resolveErr) {
      console.error(
        "Batch EV Fetch Error:",
        resolveErr instanceof Error ? resolveErr.message : resolveErr
      );
    }

    const localHit = readLocalTradeEvLookup(lookupKey, item.source);
    if (localHit) {
      const payload = safeMapApiTradeEvPayload(localHit, lookupKey);
      if (isCachedOkPayload(payload)) {
        return payload;
      }
    }

    const dynamicFallback = buildDynamicBaselineTradeEv(lookupKey, item);
    const payload = safeMapApiTradeEvPayload(dynamicFallback, lookupKey);
    seedPipelineLocalEvCache(lookupKey, payload);
    return payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Batch EV Fetch Error:", message);
    const dynamicFallback = buildDynamicBaselineTradeEv(lookupKey, item);
    const payload = safeMapApiTradeEvPayload(dynamicFallback, lookupKey);
    seedPipelineLocalEvCache(lookupKey, payload);
    return payload;
  }
}

async function enrichBatchItemsFromMappings(
  items: Map<string, { item: PipelineTradeEvInput; lookupKey: string }>
): Promise<Map<string, { item: PipelineTradeEvInput; lookupKey: string }>> {
  const pmTokenIds: string[] = [];
  const kalshiTickers: string[] = [];

  for (const { item } of Array.from(items.values())) {
    const tokenId = normalizePmTokenId(item.tokenId);
    const kalshiTicker = normalizeKalshiTicker(item.kalshiTicker);
    if (item.source === "polymarket" && tokenId && !kalshiTicker) {
      pmTokenIds.push(tokenId);
    }
    if (item.source === "kalshi" && kalshiTicker && !tokenId) {
      kalshiTickers.push(kalshiTicker);
    }
  }

  const [pmMappings, kalshiMappings] = await Promise.all([
    prefetchMappingsByPmTokenIds(pmTokenIds),
    prefetchMappingsByKalshiTickers(kalshiTickers),
  ]);

  const enriched = new Map<
    string,
    { item: PipelineTradeEvInput; lookupKey: string }
  >();

  for (const [lookupKey, row] of Array.from(items.entries())) {
    const tokenId = normalizePmTokenId(row.item.tokenId);
    const kalshiTicker = normalizeKalshiTicker(row.item.kalshiTicker);
    const mapping =
      (tokenId ? pmMappings.get(tokenId) : null) ??
      (kalshiTicker ? kalshiMappings.get(kalshiTicker) : null) ??
      null;

    enriched.set(lookupKey, {
      lookupKey,
      item: enrichPipelineEvInputFromMapping(row.item, mapping),
    });
  }

  return enriched;
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

    for (const { lookupKey, item } of Array.from(unique.values())) {
      try {
        const payload = await resolveBatchTradeEv(lookupKey, item);
        byKey[lookupKey] = payload;
        entries.push(payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Batch EV Fetch Error:", message);
        const fallback = buildDynamicBaselineTradeEv(lookupKey, item);
        const payload = safeMapApiTradeEvPayload(fallback, lookupKey);
        seedPipelineLocalEvCache(lookupKey, payload);
        byKey[lookupKey] = payload;
        entries.push(payload);
      }
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

    const entry = await resolveBatchTradeEv(lookupKey, resolvedItem);
    console.log("Final Sent Payload Sample:", entry);
    return NextResponse.json({ entry }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Batch EV Fetch Error:", message);
    return NextResponse.json(
      { entry: createUnmappedPipelineTradeEv(lookupKey, item) },
      { status: 200 }
    );
  }
}
