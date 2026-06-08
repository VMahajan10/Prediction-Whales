import type { Contract, Market } from "@/lib/polymarket";

const PREDICTIT_API_URL = "https://www.predictit.org/api/marketdata/all/";

interface PredictItContract {
  id: number;
  name: string;
  status: string;
  lastTradePrice: number;
  bestBuyYesCost: number | null;
  bestSellYesCost: number | null;
}

interface PredictItMarket {
  id: number;
  name: string;
  shortName: string;
  url: string;
  contracts: PredictItContract[];
}

interface PredictItResponse {
  markets: PredictItMarket[];
}

function isBinaryMarket(market: PredictItMarket): boolean {
  if (market.contracts.length === 1) {
    return true;
  }

  if (market.contracts.length === 2) {
    const names = market.contracts.map((c) => c.name);
    return names.includes("Yes") || names.includes("No");
  }

  return false;
}

function getFirstOpenContract(
  market: PredictItMarket
): PredictItContract | null {
  return market.contracts.find((c) => c.status === "Open") ?? null;
}

function mapContract(contract: PredictItContract): Contract {
  return {
    id: contract.id,
    name: contract.name,
    status: contract.status,
    lastTradePrice: contract.lastTradePrice,
    bestBuyYesCost: contract.bestBuyYesCost ?? 0,
    bestSellYesCost: contract.bestSellYesCost ?? 0,
  };
}

function normalizePredictItMarket(market: PredictItMarket): Market | null {
  const contract = getFirstOpenContract(market);
  if (!contract) return null;

  const bestBuy = contract.bestBuyYesCost;
  if (bestBuy == null || bestBuy === 0) {
    return null;
  }

  const bestSell = contract.bestSellYesCost ?? 0;

  return {
    id: String(market.id),
    conditionId: String(market.id),
    clobTokenIds: [],
    question: market.name,
    probability: Math.round(bestBuy * 1000) / 1000,
    volume: 0,
    spread:
      Math.round((bestBuy - bestSell) * 100 * 10) / 10,
    active: contract.status === "Open",
    source: "predictit",
    rawContracts: market.contracts
      .filter((c) => c.status === "Open")
      .map(mapContract),
    url: market.url,
  };
}

export function normalizePredictIt(data: PredictItResponse): Market[] {
  if (!Array.isArray(data.markets)) {
    throw new Error("PredictIt API returned invalid markets payload");
  }

  return data.markets
    .filter(isBinaryMarket)
    .map(normalizePredictItMarket)
    .filter((market): market is Market => market !== null)
    .slice(0, 20);
}

export async function fetchPredictItMarkets(): Promise<Market[]> {
  const res = await fetch(PREDICTIT_API_URL, {
    headers: { Accept: "application/json" },
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    throw new Error(`PredictIt API error: ${res.status} ${res.statusText}`);
  }

  const data: PredictItResponse = await res.json();
  return normalizePredictIt(data);
}
