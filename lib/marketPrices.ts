import type { Market } from "@/lib/polymarket";

export async function fetchMarketProbabilities(): Promise<
  Record<string, number>
> {
  try {
    const [pmRes, piRes] = await Promise.all([
      fetch("/api/markets"),
      fetch("/api/kalshi"),
    ]);

    const pmData: { markets?: Market[] } = await pmRes.json();
    const piData: { markets?: Market[] } = await piRes.json();

    const probabilities: Record<string, number> = {};

    for (const market of [...(pmData.markets ?? []), ...(piData.markets ?? [])]) {
      probabilities[market.id] = market.probability;
    }

    return probabilities;
  } catch {
    return {};
  }
}
