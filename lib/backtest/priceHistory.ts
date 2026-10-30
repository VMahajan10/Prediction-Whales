import {
  fetchPriceHistory,
  type PriceHistoryFetchResult,
  type PricePoint,
} from "@/lib/clvPriceHistory";
import { fetchWithTimeout, PAGE_FETCH_TIMEOUT_MS } from "@/lib/fetchWithTimeout";

const CLOB_PRICES_URL = "https://clob.polymarket.com/prices-history";

async function fetchHistoryQuery(
  assetId: string,
  query: string
): Promise<PricePoint[]> {
  const url = `${CLOB_PRICES_URL}?market=${encodeURIComponent(assetId)}&${query}`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: PAGE_FETCH_TIMEOUT_MS,
      next: { revalidate: 86400 },
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (
      !data ||
      typeof data !== "object" ||
      !Array.isArray((data as { history?: unknown }).history)
    ) {
      return [];
    }
    const history = (data as { history: Array<{ t?: number; p?: number }> })
      .history;
    const points: PricePoint[] = [];
    for (const pt of history) {
      if (typeof pt.t === "number" && typeof pt.p === "number") {
        points.push({ t: pt.t, p: pt.p });
      }
    }
    return points;
  } catch {
    return [];
  }
}

/** Try multiple CLOB intervals; never invent points. */
export async function fetchTokenPriceHistory(
  assetId: string
): Promise<{ points: PricePoint[]; source: string | null }> {
  const attempts: Array<{ query: string; label: string }> = [
    { query: "interval=max&fidelity=60", label: "max/60" },
    { query: "interval=1h&fidelity=60", label: "1h/60" },
    { query: "interval=1d&fidelity=1440", label: "1d/1440" },
  ];

  for (const { query, label } of attempts) {
    const points = await fetchHistoryQuery(assetId, query);
    if (points.length > 0) {
      return { points, source: label };
    }
  }

  const fallback: PriceHistoryFetchResult = await fetchPriceHistory(assetId);
  if (fallback.ok && fallback.points.length > 0) {
    return { points: fallback.points, source: "max/60-lib" };
  }

  return { points: [], source: null };
}
