import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";

import { dataApiExtractableRate, extractFillsFromDataApi } from "@/lib/backtest/dataApiFills";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoryCoverage,
  walletLedgerEvents,
} from "@/lib/crossmarket/store/schema";
import { fetchActivityHistory } from "@/lib/walletLedger/fetchers";
import { ACTIVITY_API_MAX_ROWS, TRADES_API_MAX_ROWS } from "@/lib/walletLedger/constants";

export interface FillSourceEvaluation {
  rankStartUnix: number;
  rankEndUnix: number;
  hydratedWallets: number;
  sampleWallets: number;
  ledger: {
    buyRowsInWindow: number;
    extractableRows: number;
    extractableRate: number;
  };
  dataApiTrades: {
    walletsTruncated: number;
    rawRowsFetched: number;
    buyRowsInWindow: number;
    extractableBuys: number;
    extractableRate: number;
    perWalletCap: number;
  };
  dataApiActivity: {
    walletsTruncated: number;
    rawRowsFetched: number;
    tradeLikeInWindow: number;
    withAssetAndCondition: number;
    extractableRate: number;
    perWalletCap: number;
  };
  recommendation: string;
}

async function ledgerCounts(
  wallets: string[],
  rankStartUnix: number,
  rankEndUnix: number
): Promise<{ total: number; extractable: number }> {
  if (wallets.length === 0) return { total: 0, extractable: 0 };
  const db = getDb();
  const [all] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletLedgerEvents)
    .where(
      and(
        sql`lower(${walletLedgerEvents.walletAddress}) IN (${sql.join(
          wallets.map((w) => sql`${w.toLowerCase()}`),
          sql`, `
        )})`,
        eq(walletLedgerEvents.eventType, "BUY"),
        gte(walletLedgerEvents.blockTimestamp, rankStartUnix),
        lte(walletLedgerEvents.blockTimestamp, rankEndUnix)
      )
    );
  const [ext] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletLedgerEvents)
    .where(
      and(
        sql`lower(${walletLedgerEvents.walletAddress}) IN (${sql.join(
          wallets.map((w) => sql`${w.toLowerCase()}`),
          sql`, `
        )})`,
        eq(walletLedgerEvents.eventType, "BUY"),
        isNotNull(walletLedgerEvents.marketConditionId),
        isNotNull(walletLedgerEvents.assetId),
        isNotNull(walletLedgerEvents.blockTimestamp),
        gte(walletLedgerEvents.blockTimestamp, rankStartUnix),
        lte(walletLedgerEvents.blockTimestamp, rankEndUnix)
      )
    );
  return { total: all?.count ?? 0, extractable: ext?.count ?? 0 };
}

export async function evaluateFillSources(
  rankStartUnix: number,
  rankEndUnix: number,
  sampleSize = 30
): Promise<FillSourceEvaluation> {
  const db = getDb();
  const hydrated = await db
    .select({ wallet: walletHistoryCoverage.walletAddress })
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.historyComplete, true));
  const wallets = hydrated.map((r) => r.wallet.toLowerCase());
  const sample = wallets.slice(0, sampleSize);

  const ledger = await ledgerCounts(sample, rankStartUnix, rankEndUnix);
  const api = await extractFillsFromDataApi(sample, rankStartUnix, rankEndUnix, 6);

  let activityRaw = 0;
  let activityTradeLike = 0;
  let activityExtractable = 0;
  let activityTruncated = 0;
  for (const wallet of sample) {
    const act = await fetchActivityHistory(wallet);
    if (act.truncated) activityTruncated += 1;
    activityRaw += act.rows.length;
    for (const row of act.rows) {
      const ts = row.timestamp;
      if (ts == null || ts < rankStartUnix || ts > rankEndUnix) continue;
      const type = (row.type ?? "").toUpperCase();
      if (type !== "TRADE" && row.side !== "BUY") continue;
      activityTradeLike += 1;
      if (row.asset?.trim() && row.conditionId?.trim()) {
        activityExtractable += 1;
      }
    }
  }

  const ledgerRate =
    ledger.total > 0 ? ledger.extractable / ledger.total : 0;
  const tradesRate = dataApiExtractableRate(
    api.buyRowsInWindow,
    api.extractableBuys
  );
  const activityRate =
    activityTradeLike > 0 ? activityExtractable / activityTradeLike : 0;

  let recommendation =
    "Use Polymarket Data API /trades as the backtest fill source; ledger rows lack condition_id/asset_id on most BUY events.";
  if (tradesRate >= 0.9) {
    recommendation +=
      " Field completeness in-window exceeds 90% for sampled wallets (subject to per-wallet row cap).";
  } else if (tradesRate > ledgerRate) {
    recommendation +=
      ` Trades API extractable rate (${(tradesRate * 100).toFixed(1)}%) beats ledger (${(ledgerRate * 100).toFixed(2)}%).`;
  }
  recommendation +=
    " On-chain/subgraph re-index is not required for Stage 1 if API coverage suffices; whale wallets beyond the trades API offset cap need chunked backfill or on-chain replay.";

  return {
    rankStartUnix,
    rankEndUnix,
    hydratedWallets: wallets.length,
    sampleWallets: sample.length,
    ledger: {
      buyRowsInWindow: ledger.total,
      extractableRows: ledger.extractable,
      extractableRate: ledgerRate,
    },
    dataApiTrades: {
      walletsTruncated: api.walletsTruncated,
      rawRowsFetched: api.rawTradeRows,
      buyRowsInWindow: api.buyRowsInWindow,
      extractableBuys: api.extractableBuys,
      extractableRate: tradesRate,
      perWalletCap: TRADES_API_MAX_ROWS,
    },
    dataApiActivity: {
      walletsTruncated: activityTruncated,
      rawRowsFetched: activityRaw,
      tradeLikeInWindow: activityTradeLike,
      withAssetAndCondition: activityExtractable,
      extractableRate: activityRate,
      perWalletCap: ACTIVITY_API_MAX_ROWS,
    },
    recommendation,
  };
}

export function formatEvaluationMarkdown(ev: FillSourceEvaluation): string {
  return `# Fill source evaluation

- **Hydrated wallets:** ${ev.hydratedWallets} (sample ${ev.sampleWallets})
- **Window:** ${new Date(ev.rankStartUnix * 1000).toISOString().slice(0, 10)} → ${new Date(ev.rankEndUnix * 1000).toISOString().slice(0, 10)}

| Source | BUY / trade-like in window | With condition + asset | Extractable % | Cap / wallet |
|--------|---------------------------:|-----------------------:|--------------:|-------------:|
| Ledger (indexed DB) | ${ev.ledger.buyRowsInWindow} | ${ev.ledger.extractableRows} | ${(ev.ledger.extractableRate * 100).toFixed(2)}% | — |
| Data API \`/trades\` | ${ev.dataApiTrades.buyRowsInWindow} | ${ev.dataApiTrades.extractableBuys} | ${(ev.dataApiTrades.extractableRate * 100).toFixed(1)}% | ${ev.dataApiTrades.perWalletCap} |
| Data API \`/activity\` | ${ev.dataApiActivity.tradeLikeInWindow} | ${ev.dataApiActivity.withAssetAndCondition} | ${(ev.dataApiActivity.extractableRate * 100).toFixed(1)}% | ${ev.dataApiActivity.perWalletCap} |

- Trades wallets truncated: ${ev.dataApiTrades.walletsTruncated}/${ev.sampleWallets}
- Activity wallets truncated: ${ev.dataApiActivity.walletsTruncated}/${ev.sampleWallets}

## Recommendation

${ev.recommendation}
`;
}
