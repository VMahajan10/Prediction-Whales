import { NextRequest, NextResponse } from "next/server";
import {
  createUnmappedPipelineTradeEv,
  pipelineTradeEvKey,
  resolvePipelineTradeEv,
  type PipelineTradeEvInput,
} from "@/lib/evPipeline/resolveTradeEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { normalizePipelineLookupKey } from "@/lib/evPipeline/types";
import {
  mergeLocalEvCache,
  readLocalTradeEvLookup,
  initGlobalLocalEvCache,
} from "@/lib/evPipeline/redisCache";
import {
  normalizePipelineTradeEv,
  strictApiTradeEvPayload,
} from "@/lib/evPipeline/tradeEvRecord";

initGlobalLocalEvCache();

export const dynamic = "force-dynamic";

interface TradeEvRequestItem {
  source: "polymarket" | "kalshi";
  tokenId?: string;
  kalshiTicker?: string;
  ticker?: string;
  tradePrice?: number;
  price?: number;
}

function normalizeItem(item: TradeEvRequestItem): PipelineTradeEvInput | null {
  const source = item.source;
  if (source !== "polymarket" && source !== "kalshi") return null;

  return {
    source,
    tokenId: item.tokenId?.trim(),
    kalshiTicker: (item.kalshiTicker ?? item.ticker)?.trim(),
    tradePrice: item.tradePrice ?? item.price,
  };
}

function sanitizeLookupKey(
  rawKey: string,
  source: PipelineTradeEvInput["source"]
): string {
  return normalizePipelineLookupKey(rawKey, source);
}

function mapApiTradeEvPayload(
  item: PipelineTradeEv,
  lookupKey: string
): PipelineTradeEv {
  const normalized = normalizePipelineTradeEv(item, lookupKey) ?? item;
  return strictApiTradeEvPayload(normalized, lookupKey);
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
  rawKey: string,
  item: PipelineTradeEvInput
): Promise<PipelineTradeEv> {
  const searchKey = sanitizeLookupKey(rawKey, item.source);

  try {
    const localHit = readLocalTradeEvLookup(searchKey, item.source);
    if (localHit) {
      const payload = safeMapApiTradeEvPayload(localHit, searchKey);
      if (isCachedOkPayload(payload)) {
        return payload;
      }
    }

    const row = await resolvePipelineTradeEv(item);
    const result = row ?? createUnmappedPipelineTradeEv(searchKey, item);
    const payload = safeMapApiTradeEvPayload(result, searchKey);

    if (isCachedOkPayload(payload)) {
      try {
        mergeLocalEvCache({ [searchKey]: payload });
      } catch (mergeErr) {
        console.error(
          "Batch EV Fetch Error:",
          mergeErr instanceof Error ? mergeErr.message : mergeErr
        );
      }
    }

    return payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Batch EV Fetch Error:", message);
    return createUnmappedPipelineTradeEv(searchKey, item);
  }
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

    const items = (body.items ?? [])
      .map(normalizeItem)
      .filter((item): item is PipelineTradeEvInput => item != null);

    const unique = new Map<string, PipelineTradeEvInput>();
    for (const item of items) {
      const rawKey = pipelineTradeEvKey(item);
      if (!rawKey) continue;
      const searchKey = sanitizeLookupKey(rawKey, item.source);
      unique.set(searchKey, item);
    }

    for (const [searchKey, item] of Array.from(unique.entries())) {
      try {
        const payload = await resolveBatchTradeEv(searchKey, item);
        byKey[searchKey] = payload;
        entries.push(payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Batch EV Fetch Error:", message);
        const fallback = createUnmappedPipelineTradeEv(searchKey, item);
        byKey[searchKey] = fallback;
        entries.push(fallback);
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

    const responseData = { entries, byKey };
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
    tokenId: searchParams.get("tokenId") ?? undefined,
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

  const rawKey = pipelineTradeEvKey(item);
  if (!rawKey) {
    return NextResponse.json({ entry: null }, { status: 200 });
  }

  const searchKey = sanitizeLookupKey(rawKey, item.source);

  try {
    const entry = await resolveBatchTradeEv(searchKey, item);
    console.log("Final Sent Payload Sample:", entry);
    return NextResponse.json({ entry }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Batch EV Fetch Error:", message);
    return NextResponse.json(
      { entry: createUnmappedPipelineTradeEv(searchKey, item) },
      { status: 200 }
    );
  }
}
