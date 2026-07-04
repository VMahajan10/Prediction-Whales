import type { EvPlatform } from "@/lib/finance/evEngine";
import {
  computeTradeEvDisplay,
} from "@/lib/evPipeline/computeTradeEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  normalizeKalshiTicker,
  normalizePmTokenId,
  pipelineMappingPairKey,
} from "@/lib/evPipeline/crossAssetLookup";

/** Display percent from probability units (0.13 → 13.0). */
export function toEvDisplayPercent(probabilityUnits: number): number {
  return Math.round(probabilityUnits * 1000) / 10;
}

/** Default market mid when order book data is unavailable. */
export const DEFAULT_P_MARKET_FALLBACK = 0.5;

/** Minor net drag applied to on-the-fly baseline payloads (gas/fees). */
export const DYNAMIC_BASELINE_NET_EV_DRAG = -0.0005;

/**
 * Normalize whale/API trade prices to probability units (0–1).
 * Accepts 0.33 or cent-style values like 33 → 0.33.
 */
export function normalizeIncomingTradePrice(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const parsed = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;

  if (parsed > 1) {
    if (parsed <= 100) return parsed / 100;
    return undefined;
  }

  return parsed;
}

/** Simple gross-edge fallback: (pTrue - pMarket) × 100. */
export function fallbackNetEvPercent(pTrue: number, pMarket: number): number {
  return toEvDisplayPercent(pTrue - pMarket);
}

/** Coerce signed-zero to +0 for display fields. Preserves negative EV percentages. */
export function sanitizeEvPercent(value: number): number {
  if (Object.is(value, -0)) return 0;
  return value;
}

/** Probability-unit deltas (grossEv / netEv) — only normalize signed-zero. */
export function sanitizeProbDelta(value: number): number {
  if (Object.is(value, -0)) return 0;
  return value;
}

/**
 * Prefer netEvPercent for card display — averageEv can be a stale zero from cache
 * while netEvPercent still carries the signed edge.
 */
export function coalesceDisplayEvPercent(
  ev:
    | Pick<PipelineTradeEv, "netEvPercent" | "grossEvPercent" | "averageEv">
    | null
    | undefined
): number | null {
  if (!ev) return null;
  for (const value of [ev.netEvPercent, ev.grossEvPercent, ev.averageEv]) {
    if (value != null && Number.isFinite(value)) {
      return sanitizeEvPercent(value);
    }
  }
  return null;
}

/** Client display bundle — single source for badge / whale feed EV cells. */
export function resolvePipelineDisplayEv(
  ev: PipelineTradeEv | null | undefined
): {
  netEvPercent: number;
  lowConfidence: boolean;
  pTrue: number;
  pMarket: number | null;
  pTrueSource: PipelineTradeEv["pTrueSource"];
} | null {
  if (ev?.status !== "ok" || ev.pTrue == null || !Number.isFinite(ev.pTrue)) {
    return null;
  }
  const netEvPercent = coalesceDisplayEvPercent(ev);
  if (netEvPercent == null) return null;

  return {
    netEvPercent,
    lowConfidence: ev.pTrueLowConfidence ?? false,
    pTrue: ev.pTrue,
    pMarket: ev.pMarket ?? ev.pmMid ?? ev.kalshiMid ?? null,
    pTrueSource: ev.pTrueSource ?? null,
  };
}

export function pipelineEvTooltip(
  ev: PipelineTradeEv,
  display?: ReturnType<typeof resolvePipelineDisplayEv>
): string {
  const row = display ?? resolvePipelineDisplayEv(ev);
  if (!row) return "AI pipeline EV";

  const parts = [
    `p_true ${(row.pTrue * 100).toFixed(1)}¢`,
    row.pMarket != null
      ? `market ${(row.pMarket * 100).toFixed(1)}¢`
      : null,
    row.pTrueSource ? `source: ${row.pTrueSource}` : null,
    row.lowConfidence ? "low-confidence estimate" : null,
    ev.evFormulaVersion ? `formula: ${ev.evFormulaVersion}` : null,
  ].filter(Boolean);

  return `AI pipeline EV · ${parts.join(" · ")}`;
}

/** Final client/API payload — numeric EV fields aligned with coalesceDisplayEvPercent. */
export function sealClientTradeEvPayload(
  item: PipelineTradeEv,
  lookupKey?: string
): PipelineTradeEv {
  const key = lookupKey ?? item.key;
  const normalized = normalizePipelineTradeEv(item, key) ?? item;
  const sealed = strictApiTradeEvPayload(normalized, key);

  if (sealed.status === "ok" && sealed.pTrue != null) {
    const display = coalesceDisplayEvPercent(sealed);
    if (display == null) {
      console.warn(
        `[ev/trades] contract violation: status ok with p_true but no display EV (${key})`
      );
    }
  }

  return sealed;
}

/**
 * Stale Redis/API lookup — averageEv stuck at 0 while signed netEvPercent exists,
 * or p_true present without any displayable EV.
 */
export function isStaleEvLookupPayload(
  ev: PipelineTradeEv | null | undefined
): boolean {
  if (!ev || ev.status !== "ok") return false;
  const display = coalesceDisplayEvPercent(ev);
  const staleZeroAverage =
    ev.averageEv === 0 &&
    display != null &&
    display !== 0 &&
    Math.abs(display) > 1e-9;
  const missingDisplay = ev.pTrue != null && display == null;
  return staleZeroAverage || missingDisplay;
}

/** Estimate display EV% from cached p_true vs trade price or market reference. */
export function deriveEvPercentFromPTrue(
  pTrue: number,
  tradePrice?: number | null,
  pMarket?: number | null
): number | null {
  if (!Number.isFinite(pTrue)) return null;
  const execution = normalizeIncomingTradePrice(tradePrice);
  const reference =
    execution ??
    (pMarket != null && Number.isFinite(pMarket) ? pMarket : null);
  if (reference == null) return null;
  return fallbackNetEvPercent(pTrue, reference);
}

/**
 * Hard-assign response fields for status ok — guarantees netEvPercent is numeric.
 */
export function strictApiTradeEvPayload(
  item: PipelineTradeEv,
  lookupKey?: string
): PipelineTradeEv {
  const key = lookupKey ?? item.key;
  if (item.status !== "ok") return { ...item, key };

  const pTrue = readOptionalNumber(item.pTrue);
  if (pTrue == null) {
    return { ...item, key, status: "ok" };
  }

  const platform: EvPlatform =
    item.kalshiTicker && !item.tokenId ? "kalshi" : "polymarket";
  const pMarket =
    readOptionalNumber(item.pMarket) ?? DEFAULT_P_MARKET_FALLBACK;
  const evDisplay = computeTradeEvDisplay({
    pTrue,
    executionPrice: pMarket,
    platform,
    pMarketFallback: pMarket,
  });

  let netEvPercent = sanitizeEvPercent(
    item.netEvPercent ?? evDisplay.netEvPercent
  );
  let grossEvPercent = sanitizeEvPercent(
    item.grossEvPercent ?? evDisplay.grossEvPercent
  );
  let netEv = sanitizeProbDelta(item.netEv ?? evDisplay.netEv);
  let grossEv = sanitizeProbDelta(item.grossEv ?? evDisplay.grossEv);

  return {
    ...item,
    key,
    status: "ok",
    pTrue,
    pMarket,
    netEvPercent,
    netEv,
    grossEv,
    grossEvPercent,
    averageEv: netEvPercent,
    evFormulaVersion: evDisplay.formula,
  };
}

function readOptionalNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalize Redis/API payloads so frontend always receives camelCase fields.
 * Fills netEvPercent when status is ok but the value was never persisted.
 */
export function normalizePipelineTradeEv(
  raw: Partial<PipelineTradeEv> & { key?: string },
  lookupKey?: string
): PipelineTradeEv | null {
  const key = lookupKey ?? raw.key;
  if (!key) return null;

  const status = raw.status ?? "unmapped";
  const tokenId = normalizePmTokenId(
    typeof raw.tokenId === "string" ? raw.tokenId : null
  );
  const kalshiTicker = normalizeKalshiTicker(
    typeof raw.kalshiTicker === "string" ? raw.kalshiTicker : null
  );
  const mappingPairKey =
    tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : raw.mappingPairKey ?? null;

  const pTrue =
    readOptionalNumber(raw.pTrue) ??
    readOptionalNumber((raw as Record<string, unknown>).p_true);
  const pMarket =
    readOptionalNumber(raw.pMarket) ??
    readOptionalNumber((raw as Record<string, unknown>).p_market);
  const pmMid =
    readOptionalNumber(raw.pmMid) ??
    readOptionalNumber((raw as Record<string, unknown>).pm_mid);
  const kalshiMid =
    readOptionalNumber(raw.kalshiMid) ??
    readOptionalNumber((raw as Record<string, unknown>).kalshi_mid);

  let netEvPercent =
    readOptionalNumber(raw.netEvPercent) ??
    readOptionalNumber((raw as Record<string, unknown>).net_ev_percent);

  let netEv =
    readOptionalNumber(raw.netEv) ??
    readOptionalNumber((raw as Record<string, unknown>).net_ev);
  let grossEv =
    readOptionalNumber(raw.grossEv) ??
    readOptionalNumber((raw as Record<string, unknown>).gross_ev);
  let grossEvPercent =
    readOptionalNumber(raw.grossEvPercent) ??
    readOptionalNumber((raw as Record<string, unknown>).gross_ev_percent);

  if (status === "unmapped" || status === "error") {
    return {
      key,
      status,
      tokenId,
      kalshiTicker,
      mappingPairKey,
      netEvPercent: null,
      netEv: 0,
      grossEv: 0,
      grossEvPercent: null,
      pTrue: null,
      pMarket: null,
      pmMid: null,
      kalshiMid: null,
    };
  }

  if (pTrue != null) {
    const resolvedPMarket = pMarket ?? DEFAULT_P_MARKET_FALLBACK;
    const platform: EvPlatform =
      kalshiTicker && !tokenId ? "kalshi" : "polymarket";
    const evDisplay = computeTradeEvDisplay({
      pTrue,
      executionPrice: resolvedPMarket,
      platform,
      pMarketFallback: resolvedPMarket,
    });

    return strictApiTradeEvPayload(
      {
        key,
        status: "ok",
        tokenId,
        kalshiTicker,
        mappingPairKey,
        pTrue,
        pMarket: resolvedPMarket,
        pmMid,
        kalshiMid,
        grossEv: grossEv ?? evDisplay.grossEv,
        netEv: netEv ?? evDisplay.netEv,
        grossEvPercent: grossEvPercent ?? evDisplay.grossEvPercent,
        netEvPercent: netEvPercent ?? evDisplay.netEvPercent,
        pTrueSource: raw.pTrueSource ?? undefined,
        pTrueConfidence: raw.pTrueConfidence ?? undefined,
        pTrueLowConfidence: raw.pTrueLowConfidence ?? undefined,
        evFormulaVersion: raw.evFormulaVersion ?? evDisplay.formula,
      },
      key
    );
  }

  return {
    key,
    status: "ok",
    tokenId,
    kalshiTicker,
    mappingPairKey,
    pTrue,
    pMarket,
    pmMid,
    kalshiMid,
    grossEv: grossEv ?? 0,
    netEv: netEv ?? 0,
    grossEvPercent: grossEvPercent ?? null,
    netEvPercent: netEvPercent ?? null,
  };
}

export function buildOkPipelineTradeEv(params: {
  lookupKey: string;
  platform: EvPlatform;
  tokenId: string;
  kalshiTicker: string;
  pTrue: number;
  pMarket: number;
}): PipelineTradeEv {
  const { lookupKey, platform, tokenId, kalshiTicker, pTrue, pMarket } =
    params;
  const normalizedTokenId = normalizePmTokenId(tokenId);
  const normalizedKalshiTicker = normalizeKalshiTicker(kalshiTicker);
  const mappingPairKey =
    normalizedTokenId && normalizedKalshiTicker
      ? pipelineMappingPairKey(normalizedTokenId, normalizedKalshiTicker)
      : null;

  const evDisplay = computeTradeEvDisplay({
    pTrue,
    executionPrice: pMarket,
    platform,
    pMarketFallback: pMarket,
  });

  return {
    key: lookupKey,
    status: "ok",
    tokenId: normalizedTokenId,
    kalshiTicker: normalizedKalshiTicker,
    mappingPairKey,
    pTrue,
    pMarket,
    grossEv: sanitizeProbDelta(evDisplay.grossEv),
    netEv: sanitizeProbDelta(evDisplay.netEv),
    grossEvPercent: sanitizeEvPercent(evDisplay.grossEvPercent),
    netEvPercent: sanitizeEvPercent(evDisplay.netEvPercent),
    averageEv: sanitizeEvPercent(evDisplay.netEvPercent),
    evFormulaVersion: evDisplay.formula,
  };
}
