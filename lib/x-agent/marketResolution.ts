import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

const GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";

interface GammaMarket {
  closed?: boolean;
  resolved?: boolean;
  outcomePrices?: string;
  outcomes?: string;
  question?: string;
}

function parseJsonArray(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * True when the Polymarket market slug is closed/resolved with a YES outcome
 * matching the named `side` from our translation layer.
 */
export async function isMarketResolvedYesForSide(
  marketSlug: string,
  side: string
): Promise<boolean> {
  const slug = marketSlug.trim();
  const namedSide = side.trim();
  if (!slug || !namedSide) return false;

  const url = `${GAMMA_MARKETS_URL}?slug=${encodeURIComponent(slug)}`;
  const response = await fetchWithTimeout(url, { timeoutMs: 12_000 });
  if (!response.ok) return false;

  const markets = (await response.json().catch(() => null)) as
    | GammaMarket[]
    | null;
  const market = markets?.[0];
  if (!market) return false;

  const closed = market.closed === true || market.resolved === true;
  if (!closed) return false;

  const outcomes = parseJsonArray(market.outcomes);
  const prices = parseJsonArray(market.outcomePrices).map((p) => Number(p));

  const yesIndex = outcomes.findIndex(
    (o) => normalizeLabel(o) === "yes" || normalizeLabel(o) === namedSide
  );
  const sideIndex = outcomes.findIndex(
    (o) => normalizeLabel(o) === normalizeLabel(namedSide)
  );

  const index = sideIndex >= 0 ? sideIndex : yesIndex;
  if (index < 0 || !Number.isFinite(prices[index])) return false;

  return prices[index] >= 0.99;
}
