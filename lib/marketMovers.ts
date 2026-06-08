import type { MarketSummary } from "@/lib/polymarket";

export type Market = MarketSummary;

export interface Mover {
  question: string;
  volume: number;
  startProb: number;
  currentProb: number;
  delta: number;
  absDelta: number;
}

interface HistoryPoint {
  t: number;
  p: number;
}

interface HistoryResponse {
  history?: HistoryPoint[];
  error?: string;
}

const MIN_ABS_DELTA = 0.005;

async function fetchHistory(tokenId: string): Promise<HistoryPoint[]> {
  const res = await fetch(`/api/history?tokenId=${encodeURIComponent(tokenId)}`);
  const data: HistoryResponse = await res.json();
  return data.history ?? [];
}

export async function detectMovers(markets: Market[]): Promise<Mover[]> {
  const results = await Promise.all(
    markets.map(async (market) => {
      const tokenId = market.clobTokenIds[0];
      if (!tokenId) return null;

      const history = await fetchHistory(tokenId);
      if (history.length < 2) return null;

      const startProb = history[0].p;
      const currentProb = history[history.length - 1].p;
      const delta = currentProb - startProb;
      const absDelta = Math.abs(delta);

      if (absDelta <= MIN_ABS_DELTA) return null;

      return {
        question: market.question,
        volume: market.volume,
        startProb,
        currentProb,
        delta,
        absDelta,
      } satisfies Mover;
    })
  );

  return results
    .filter((mover): mover is Mover => mover !== null)
    .sort((a, b) => b.absDelta - a.absDelta);
}
