import { inferMarketCategory } from "@/lib/marketCategory";
import type { WhaleTrade } from "@/lib/whaleTrades";

const STORAGE_KEY = "marketpulse:traderAlerts:v1";
export const TRADER_ALERTS_CHANGED_EVENT = "marketpulse:trader-alerts-changed";

export interface TraderAlert {
  id: string;
  wallet: string;
  traderLabel: string;
  title: string;
  outcome: string;
  side: "BUY" | "SELL";
  price: number;
  usdNotional: number;
  detectedAt: number;
  read: boolean;
  category: string;
  source: "polymarket" | "kalshi";
  txHash?: string;
}

function readAll(): TraderAlert[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TraderAlert[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(alerts: TraderAlert[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts.slice(0, 200)));
    window.dispatchEvent(new CustomEvent(TRADER_ALERTS_CHANGED_EVENT));
  } catch {
    // Quota or serialization failure — non-fatal.
  }
}

export function getTraderAlerts(): TraderAlert[] {
  return readAll().sort((a, b) => b.detectedAt - a.detectedAt);
}

export function getUnreadAlertCount(): number {
  return readAll().filter((a) => !a.read).length;
}

export function markAlertRead(id: string): void {
  writeAll(
    readAll().map((a) => (a.id === id ? { ...a, read: true } : a))
  );
}

export function markAllAlertsRead(): void {
  writeAll(readAll().map((a) => ({ ...a, read: true })));
}

export function alertFromWhaleTrade(
  trade: WhaleTrade,
  wallet: string,
  traderLabel: string
): TraderAlert {
  const id =
    trade.source === "kalshi"
      ? `kalshi:${trade.id}`
      : trade.transactionHash || trade.id;
  const side =
    trade.source === "kalshi"
      ? trade.outcome === "Yes"
        ? "BUY"
        : "SELL"
      : trade.side;

  return {
    id,
    wallet: wallet.toLowerCase(),
    traderLabel,
    title: trade.title,
    outcome: trade.outcome,
    side,
    price: trade.price,
    usdNotional: trade.usdNotional,
    detectedAt: trade.detectedAt,
    read: false,
    category: inferMarketCategory(trade.title),
    source: trade.source,
    txHash: trade.transactionHash || undefined,
  };
}

export function upsertTraderAlert(alert: TraderAlert): void {
  const existing = readAll();
  const idx = existing.findIndex((a) => a.id === alert.id);
  if (idx >= 0) {
    writeAll(existing);
    return;
  }
  writeAll([alert, ...existing]);
}
