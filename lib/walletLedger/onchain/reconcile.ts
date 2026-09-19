import type { ActivityApiRow, TradeApiRow, WalletLedgerEvent } from "@/lib/walletLedger/types";
import type { ReconciliationReport } from "@/lib/walletLedger/onchain/types";

export interface ApiTradeLike {
  transactionHash?: string;
  timestamp?: number;
  side?: string;
  size?: number;
  price?: number;
  usdcSize?: number;
  asset?: string;
  conditionId?: string;
}

function apiTradeKey(row: ApiTradeLike): string {
  return [
    (row.transactionHash ?? "").toLowerCase(),
    row.side ?? "",
    row.asset ?? "",
    row.conditionId ?? "",
    String(row.timestamp ?? 0),
    String(row.size ?? 0),
    String(row.price ?? 0),
  ].join("|");
}

function chainTradeKey(event: WalletLedgerEvent): string {
  return [
    (event.txHash ?? "").toLowerCase(),
    event.type,
    event.asset,
    event.conditionId,
    String(event.timestamp),
    String(event.shares ?? 0),
    String(event.price ?? 0),
  ].join("|");
}

export function reconcileApiAndChainTrades(
  activityRows: ActivityApiRow[],
  tradeRows: TradeApiRow[],
  chainEvents: WalletLedgerEvent[]
): ReconciliationReport {
  const apiTrades: ApiTradeLike[] = [];
  for (const row of activityRows) {
    if ((row.type ?? "").toUpperCase() === "TRADE") apiTrades.push(row);
  }
  for (const row of tradeRows) apiTrades.push(row);

  const apiKeys = new Map<string, ApiTradeLike>();
  for (const row of apiTrades) {
    apiKeys.set(apiTradeKey(row), row);
  }

  const chainTradeEvents = chainEvents.filter(
    (e) => e.type === "BUY" || e.type === "SELL"
  );
  const chainKeys = new Map<string, WalletLedgerEvent>();
  for (const event of chainTradeEvents) {
    chainKeys.set(chainTradeKey(event), event);
  }

  const chainByTx = new Map<string, WalletLedgerEvent[]>();
  for (const event of chainKeys.values()) {
    const tx = (event.txHash ?? "").toLowerCase();
    if (!tx) continue;
    const list = chainByTx.get(tx) ?? [];
    list.push(event);
    chainByTx.set(tx, list);
  }

  const matchedTx = new Set<string>();
  let matched = 0;
  for (const [, row] of apiKeys.entries()) {
    const tx = (row.transactionHash ?? "").toLowerCase();
    const chainMatch = (chainByTx.get(tx) ?? []).find(
      (e) => Math.abs((e.shares ?? 0) - Number(row.size ?? 0)) < 0.01
    );
    if (chainMatch) {
      matched += 1;
      matchedTx.add(tx);
    }
  }

  const apiOnly = apiTrades.filter((row) => {
    const tx = (row.transactionHash ?? "").toLowerCase();
    return tx && !matchedTx.has(tx);
  }).length;

  const chainOnly = chainTradeEvents.filter((event) => {
    const tx = (event.txHash ?? "").toLowerCase();
    return tx && !apiKeys.has(chainTradeKey(event)) && !matchedTx.has(tx);
  }).length;

  const samples = [
    ...apiTrades.slice(0, 3).map((row) => ({
      status: matchedTx.has((row.transactionHash ?? "").toLowerCase())
        ? ("matched" as const)
        : ("api_only" as const),
      txHash: row.transactionHash ?? "",
      detail: `api ${row.side} size=${row.size} asset=${row.asset}`,
    })),
    ...chainTradeEvents.slice(0, 3).map((event) => ({
      status: matchedTx.has((event.txHash ?? "").toLowerCase())
        ? ("matched" as const)
        : ("chain_only" as const),
      txHash: event.txHash ?? "",
      detail: `chain ${event.type} shares=${event.shares} asset=${event.asset}`,
    })),
  ];

  return {
    apiTradeCount: apiTrades.length,
    chainTradeCount: chainTradeEvents.length,
    matchedEvents: matched,
    apiOnlyEvents: apiOnly,
    chainOnlyEvents: chainOnly,
    matchRate: apiTrades.length > 0 ? matched / apiTrades.length : 0,
    samples,
  };
}
