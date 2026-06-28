import {
  calculateTrueEV,
  type EvPlatform,
} from "@/lib/finance/evEngine";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";

/** Display percent from probability units (0.13 → 13.0). */
export function toEvDisplayPercent(probabilityUnits: number): number {
  return Math.round(probabilityUnits * 1000) / 10;
}

/** Default market mid when order book data is unavailable. */
export const DEFAULT_P_MARKET_FALLBACK = 0.5;

/** Simple gross-edge fallback: (pTrue - pMarket) × 100. */
export function fallbackNetEvPercent(pTrue: number, pMarket: number): number {
  return toEvDisplayPercent(pTrue - pMarket);
}

/** Coerce -0 to 0 so UI truthiness checks behave correctly. */
export function sanitizeEvPercent(value: number): number {
  if (Object.is(value, -0) || value === 0) return 0;
  return value;
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

  const pMarket =
    readOptionalNumber(item.pMarket) ?? DEFAULT_P_MARKET_FALLBACK;
  const calculatedEvPercent = sanitizeEvPercent(
    fallbackNetEvPercent(pTrue, pMarket)
  );
  const calculatedNetEv = sanitizeEvPercent(pTrue - pMarket);

  let netEvPercent = sanitizeEvPercent(
    item.netEvPercent ?? calculatedEvPercent
  );
  let grossEvPercent = sanitizeEvPercent(
    item.grossEvPercent ?? calculatedEvPercent
  );
  let netEv = sanitizeEvPercent(item.netEv ?? calculatedNetEv);
  let grossEv = sanitizeEvPercent(item.grossEv ?? calculatedNetEv);

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
  const tokenId =
    typeof raw.tokenId === "string" ? raw.tokenId.toLowerCase() : null;
  const kalshiTicker =
    typeof raw.kalshiTicker === "string"
      ? raw.kalshiTicker.toUpperCase()
      : null;

  const pTrue =
    readOptionalNumber(raw.pTrue) ??
    readOptionalNumber((raw as Record<string, unknown>).p_true);
  const pMarket =
    readOptionalNumber(raw.pMarket) ??
    readOptionalNumber((raw as Record<string, unknown>).p_market);

  let netEvPercent =
    readOptionalNumber(raw.netEvPercent) ??
    readOptionalNumber((raw as Record<string, unknown>).net_ev_percent);

  let netEv =
    readOptionalNumber(raw.netEv) ??
    readOptionalNumber((raw as Record<string, unknown>).net_ev) ??
    0;
  let grossEv =
    readOptionalNumber(raw.grossEv) ??
    readOptionalNumber((raw as Record<string, unknown>).gross_ev) ??
    0;
  let grossEvPercent =
    readOptionalNumber(raw.grossEvPercent) ??
    readOptionalNumber((raw as Record<string, unknown>).gross_ev_percent);

  if (status === "unmapped" || status === "error") {
    return {
      key,
      status,
      tokenId,
      kalshiTicker,
      netEvPercent: null,
      netEv: 0,
      grossEv: 0,
      grossEvPercent: null,
      pTrue: null,
      pMarket: null,
    };
  }

  if (pTrue != null) {
    const resolvedPMarket = pMarket ?? DEFAULT_P_MARKET_FALLBACK;
    const calculatedEvPercent = fallbackNetEvPercent(pTrue, resolvedPMarket);
    const calculatedNetEv = pTrue - resolvedPMarket;

    return strictApiTradeEvPayload(
      {
        key,
        status: "ok",
        tokenId,
        kalshiTicker,
        pTrue,
        pMarket: resolvedPMarket,
        grossEv: grossEv || calculatedNetEv,
        netEv: netEv || calculatedNetEv,
        grossEvPercent: grossEvPercent ?? calculatedEvPercent,
        netEvPercent: netEvPercent ?? calculatedEvPercent,
      },
      key
    );
  }

  return {
    key,
    status: "ok",
    tokenId,
    kalshiTicker,
    pTrue,
    pMarket,
    grossEv,
    netEv,
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

  let grossEv = pTrue - pMarket;
  let netEv = grossEv;
  let grossEvPercent = fallbackNetEvPercent(pTrue, pMarket);
  let netEvPercent = grossEvPercent;

  try {
    const breakdown = calculateTrueEV(pTrue, pMarket, platform);
    grossEv = breakdown.grossEv;
    netEv = breakdown.netEv;
    grossEvPercent = toEvDisplayPercent(breakdown.grossEv);
    netEvPercent = toEvDisplayPercent(breakdown.netEv);
  } catch {
    // Keep simple fallback math above.
  }

  if (!Number.isFinite(netEvPercent)) {
    netEvPercent = sanitizeEvPercent(fallbackNetEvPercent(pTrue, pMarket));
  }
  if (!Number.isFinite(grossEvPercent)) {
    grossEvPercent = sanitizeEvPercent(fallbackNetEvPercent(pTrue, pMarket));
  }

  return {
    key: lookupKey,
    status: "ok",
    tokenId: tokenId.toLowerCase(),
    kalshiTicker: kalshiTicker.toUpperCase(),
    pTrue,
    pMarket,
    grossEv: sanitizeEvPercent(grossEv),
    netEv: sanitizeEvPercent(netEv),
    grossEvPercent: sanitizeEvPercent(grossEvPercent),
    netEvPercent: sanitizeEvPercent(netEvPercent),
  };
}
