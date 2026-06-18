import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import type { RawMarket } from "./types";

const MANIFOLD_API = "https://api.manifold.markets";
const PLATFORM_FETCH_TIMEOUT_MS = 8000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

interface ManifoldMarket {
  id: string;
  question: string;
  slug?: string;
  url?: string;
  probability?: number;
  p?: number;
  volume?: number;
  totalLiquidity?: number;
  outcomeType?: string;
  isResolved?: boolean;
  [key: string]: unknown;
}

function manifoldYesPrice(m: ManifoldMarket): number | null {
  // Only binary markets have a meaningful YES probability.
  if (m.outcomeType !== "BINARY") return null;
  if (m.isResolved === true) return null;

  const prob = m.probability;
  if (typeof prob !== "number" || !Number.isFinite(prob)) return null;
  // Guard: brand-new CPMM markets can report p=0.5 with no trades; prefer
  // `probability` (pool-derived). Reject exact 0.5 only when volume is zero
  // and probability equals internal prior `p`.
  if (
    prob === 0.5 &&
    (m.volume ?? 0) === 0 &&
    typeof m.p === "number" &&
    m.p === 0.5
  ) {
    return null;
  }
  if (prob < 0 || prob > 1) return null;
  return prob;
}

function manifoldVolume(m: ManifoldMarket): number | null {
  const v = m.volume;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

function manifoldUrl(m: ManifoldMarket): string | null {
  if (m.url) return m.url;
  if (m.slug) return `https://manifold.markets/${m.slug}`;
  return m.id ? `https://manifold.markets/market/${m.id}` : null;
}

function toRawMarket(m: ManifoldMarket): RawMarket {
  return {
    platform: "manifold",
    external_id: m.id,
    tier: 1,
    title: m.question,
    raw_payload: m as Record<string, unknown>,
    yes_price: manifoldYesPrice(m),
    volume: manifoldVolume(m),
    url: manifoldUrl(m),
    yes_price_kind: "tradeable",
  };
}

/** Tier-1 Manifold fetcher — open markets via `/v0/markets` (cursor pagination). */
export async function fetchManifoldRawMarkets(): Promise<RawMarket[]> {
  const out: RawMarket[] = [];
  let before: string | undefined;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (before) params.set("before", before);

      const res = await fetchWithTimeout(
        `${MANIFOLD_API}/v0/markets?${params}`,
        {
          headers: { Accept: "application/json" },
          timeoutMs: PLATFORM_FETCH_TIMEOUT_MS,
        }
      );

      if (!res.ok) {
        console.error(
          `[crossmarket/manifold] HTTP ${res.status} on page ${page}`
        );
        break;
      }

      const markets = (await res.json()) as ManifoldMarket[];
      if (!Array.isArray(markets) || markets.length === 0) break;

      for (const m of markets) {
        if (m.isResolved) continue;
        if (!m.id || !m.question) continue;
        out.push(toRawMarket(m));
      }

      if (markets.length < PAGE_LIMIT) break;
      before = markets[markets.length - 1]?.id;
      if (!before) break;
    }
  } catch (err) {
    console.error("[crossmarket/manifold] fetch failed:", err);
  }

  return out;
}
