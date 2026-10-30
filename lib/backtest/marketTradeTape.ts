import { fetchWithTimeout, PAGE_FETCH_TIMEOUT_MS } from "@/lib/fetchWithTimeout";
import { mergeOutboundHeaders } from "@/lib/outboundHttp";
import { POLYMARKET_DATA_API_BASE } from "@/lib/walletLedger/constants";

const JSON_HEADERS = mergeOutboundHeaders({ Accept: "application/json" });
const SETTLEMENT_EPS = 0.05;
const MAX_PAGES = 20;
const PAGE_SIZE = 500;

export interface TapeTrade {
  assetId: string;
  price: number;
  size: number;
  timestamp: number;
}

export class MarketTradeTapeCache {
  private readonly byCondition = new Map<string, TapeTrade[]>();

  get(conditionId: string): TapeTrade[] | undefined {
    return this.byCondition.get(conditionId.toLowerCase());
  }

  set(conditionId: string, trades: TapeTrade[]): void {
    this.byCondition.set(conditionId.toLowerCase(), trades);
  }
}

export async function fetchConditionTradeTape(
  conditionId: string
): Promise<TapeTrade[]> {
  const trades: TapeTrade[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const url = `${POLYMARKET_DATA_API_BASE}/trades?market=${encodeURIComponent(conditionId)}&limit=${PAGE_SIZE}&offset=${offset}`;
    try {
      const res = await fetchWithTimeout(url, {
        headers: JSON_HEADERS,
        timeoutMs: PAGE_FETCH_TIMEOUT_MS,
      });
      if (!res.ok) break;
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data) || data.length === 0) break;
      for (const row of data) {
        const r = row as {
          asset?: string;
          price?: number;
          size?: number;
          timestamp?: number;
        };
        if (
          typeof r.asset !== "string" ||
          typeof r.price !== "number" ||
          typeof r.timestamp !== "number"
        ) {
          continue;
        }
        const size = typeof r.size === "number" && r.size > 0 ? r.size : 1;
        trades.push({
          assetId: r.asset,
          price: r.price,
          size,
          timestamp: r.timestamp,
        });
      }
      if (data.length < PAGE_SIZE) break;
    } catch {
      break;
    }
  }
  return trades;
}

export function vwapClosingFromTape(
  tape: TapeTrade[],
  assetId: string,
  cutoffUnix: number,
  lastN: number,
  minTrades: number
): {
  closingLine: number | null;
  closeTimestamp: number | null;
  tradeCount: number;
  valid: boolean;
} {
  const eligible = tape
    .filter(
      (t) =>
        t.assetId === assetId &&
        t.timestamp < cutoffUnix &&
        t.price > SETTLEMENT_EPS &&
        t.price < 1 - SETTLEMENT_EPS
    )
    .sort((a, b) => b.timestamp - a.timestamp);

  const window = eligible.slice(0, lastN);
  if (window.length < minTrades) {
    return {
      closingLine: null,
      closeTimestamp: null,
      tradeCount: window.length,
      valid: false,
    };
  }

  let notional = 0;
  let shares = 0;
  for (const t of window) {
    notional += t.price * t.size;
    shares += t.size;
  }
  if (shares <= 0) {
    return {
      closingLine: null,
      closeTimestamp: null,
      tradeCount: window.length,
      valid: false,
    };
  }

  const oldestInWindow = window.reduce(
    (min, t) => (t.timestamp < min ? t.timestamp : min),
    window[0].timestamp
  );

  return {
    closingLine: notional / shares,
    closeTimestamp: oldestInWindow,
    tradeCount: window.length,
    valid: true,
  };
}
