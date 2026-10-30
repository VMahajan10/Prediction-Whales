import type { BacktestFill } from "@/lib/backtest/types";
import { fetchTradeHistory } from "@/lib/walletLedger/fetchers";
import type { TradeApiRow } from "@/lib/walletLedger/types";
import { TRADES_API_MAX_ROWS } from "@/lib/walletLedger/constants";
import { mapWithConcurrency } from "@/lib/clvPriceHistory";

export interface DataApiExtractResult {
  fills: BacktestFill[];
  walletsProcessed: number;
  walletsTruncated: number;
  rawTradeRows: number;
  buyRowsInWindow: number;
  extractableBuys: number;
}

function tradeToFill(row: TradeApiRow, wallet: string): BacktestFill | null {
  if (row.side !== "BUY") return null;
  const ts = row.timestamp;
  const price = row.price;
  const asset = row.asset?.trim();
  const conditionId = row.conditionId?.trim().toLowerCase();
  if (
    ts == null ||
    ts <= 0 ||
    price == null ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !asset ||
    !conditionId
  ) {
    return null;
  }
  const size = row.size ?? 0;
  const sizeUsd = size > 0 ? size * price : price;
  return {
    walletAddress: wallet.toLowerCase(),
    conditionId,
    assetId: asset,
    side: "BUY",
    price,
    sizeUsd,
    shares: size > 0 ? size : sizeUsd / price,
    timestamp: ts,
    marketTitle: row.title ?? null,
    outcome: row.outcome ?? null,
    eventSlug: row.eventSlug ?? null,
    marketSlug: row.slug ?? null,
  };
}

export async function extractFillsFromDataApi(
  wallets: string[],
  rankStartUnix: number,
  rankEndUnix: number,
  concurrency = 4
): Promise<DataApiExtractResult> {
  const fills: BacktestFill[] = [];
  let rawTradeRows = 0;
  let buyRowsInWindow = 0;
  let extractableBuys = 0;
  let walletsTruncated = 0;

  await mapWithConcurrency(wallets, concurrency, async (wallet) => {
    const w = wallet.toLowerCase();
    const result = await fetchTradeHistory(w);
    if (result.truncated) walletsTruncated += 1;
    rawTradeRows += result.rows.length;

    for (const row of result.rows) {
      if (row.side !== "BUY") continue;
      const ts = row.timestamp;
      if (ts == null || ts < rankStartUnix || ts > rankEndUnix) continue;
      buyRowsInWindow += 1;
      const hasIds = Boolean(row.asset?.trim() && row.conditionId?.trim());
      if (hasIds) extractableBuys += 1;
      const fill = tradeToFill(row, w);
      if (fill) fills.push(fill);
    }
  });

  return {
    fills,
    walletsProcessed: wallets.length,
    walletsTruncated,
    rawTradeRows,
    buyRowsInWindow,
    extractableBuys,
  };
}

export function dataApiExtractableRate(
  buyRowsInWindow: number,
  extractableBuys: number
): number {
  if (buyRowsInWindow <= 0) return 0;
  return extractableBuys / buyRowsInWindow;
}

export { TRADES_API_MAX_ROWS };
