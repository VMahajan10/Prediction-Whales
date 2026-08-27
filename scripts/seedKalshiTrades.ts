/**
 * Seed qualifying Kalshi shadow trades for /api/trades/recent hydration.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.json scripts/seedKalshiTrades.ts
 *   npx tsx --tsconfig tsconfig.json scripts/seedKalshiTrades.ts --count 30
 */
import "./preload-env";

import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { kalshiShadowTrades } from "@/lib/crossmarket/store/schema";
import { buildKalshiShadowTradeRow } from "@/lib/x-agent/kalshiShadowTrades";

const SEED_PREFIX = "seed-kalshi-";

type SeedMarket = {
  ticker: string;
  title: string;
  selectionLabel: string;
  category: string;
  entryPrice: number;
};

const MARKETS: SeedMarket[] = [
  {
    ticker: "KXNBA-26MAR15-LAL",
    title: "Will the Lakers win vs Celtics on Mar 15?",
    selectionLabel: "Los Angeles Lakers",
    category: "sports",
    entryPrice: 0.54,
  },
  {
    ticker: "KXNFL-26FEB09-KC",
    title: "Will Kansas City win Super Bowl LX?",
    selectionLabel: "Kansas City Chiefs",
    category: "sports",
    entryPrice: 0.38,
  },
  {
    ticker: "KXBTC-26JUN30-T100K",
    title: "Bitcoin above $100k on Jun 30, 2026?",
    selectionLabel: "Above $100,000",
    category: "crypto",
    entryPrice: 0.62,
  },
  {
    ticker: "KXFED-26JUN-C25",
    title: "Fed funds rate below 4.25% after June FOMC?",
    selectionLabel: "Below 4.25%",
    category: "finance",
    entryPrice: 0.47,
  },
  {
    ticker: "KXPRES-28-DEM",
    title: "Democrat wins 2028 presidential election?",
    selectionLabel: "Democratic nominee",
    category: "politics",
    entryPrice: 0.51,
  },
  {
    ticker: "KXETH-26SEP30-T5K",
    title: "Ethereum above $5k on Sep 30, 2026?",
    selectionLabel: "Above $5,000",
    category: "crypto",
    entryPrice: 0.44,
  },
  {
    ticker: "KXMLB-26OCT-WORLD",
    title: "Dodgers win 2026 World Series?",
    selectionLabel: "Los Angeles Dodgers",
    category: "sports",
    entryPrice: 0.29,
  },
  {
    ticker: "KXEURO-26-FR",
    title: "France wins UEFA Euro 2026?",
    selectionLabel: "France",
    category: "sports",
    entryPrice: 0.18,
  },
  {
    ticker: "KXSPX-26DEC31-7000",
    title: "S&P 500 closes above 7000 on Dec 31, 2026?",
    selectionLabel: "Above 7000",
    category: "finance",
    entryPrice: 0.33,
  },
  {
    ticker: "KXOSC-26-MUS",
    title: "Anora wins Best Picture at 2026 Oscars?",
    selectionLabel: "Anora",
    category: "entertainment",
    entryPrice: 0.41,
  },
];

function parseCount(argv: string[]): number {
  const idx = argv.indexOf("--count");
  if (idx === -1) return 25;
  const parsed = Number(argv[idx + 1]);
  if (!Number.isFinite(parsed) || parsed < 1) return 25;
  return Math.min(Math.floor(parsed), 50);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function evPercentForIndex(index: number): number {
  const values = [3.2, 4.1, 5.5, 6.8, 7.4, 8.9, 9.6, 10.2, 11.7, 12.4, 13.1, 14.5];
  return values[index % values.length]!;
}

function stakeUsdForIndex(index: number): number {
  const stakes = [520, 750, 980, 1250, 1600, 2100, 2750, 3400, 4200, 5600, 7200, 9800];
  return stakes[index % stakes.length]!;
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function buildSeedTrade(index: number) {
  const market = MARKETS[index % MARKETS.length]!;
  const entryPrice = market.entryPrice;
  const usdNotional = stakeUsdForIndex(index);
  const size = roundMoney(usdNotional / entryPrice);
  const netEvPercent = evPercentForIndex(index);
  const tradedAt = hoursAgo(2 + (index % 46));
  const createdAt = hoursAgo(1 + (index % 47));
  const timestamp = Math.floor(tradedAt.getTime() / 1000);
  const side = index % 5 === 0 ? "SELL" : "BUY";
  const takerOutcomeSide = index % 3 === 0 ? "no" : "yes";
  const takerBookSide = side === "SELL" ? "ask" : "bid";

  const row = buildKalshiShadowTradeRow({
    tradeId: `${SEED_PREFIX}${String(index + 1).padStart(3, "0")}`,
    ticker: market.ticker,
    size,
    timestamp,
    entryPrice,
    takerSide: takerOutcomeSide,
    takerOutcomeSide,
    takerBookSide,
    isBlockTrade: usdNotional >= 5000,
    usdNotional,
    category: market.category,
    rawPayload: {
      title: market.title,
      outcome: takerOutcomeSide === "yes" ? "Yes" : "No",
      side,
      selectionLabel: market.selectionLabel,
      netEvPercent,
      seeded: true,
    },
  });

  return {
    ...row,
    createdAt,
    rawPayload:
      row.rawPayload != null
        ? sql`${JSON.stringify(row.rawPayload)}::jsonb`
        : null,
  };
}

async function main(): Promise<void> {
  const count = parseCount(process.argv.slice(2));

  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL is not configured.");
    process.exit(1);
  }

  const rows = Array.from({ length: count }, (_, index) => buildSeedTrade(index));
  const db = getDb();

  await db
    .insert(kalshiShadowTrades)
    .values(rows)
    .onConflictDoUpdate({
      target: kalshiShadowTrades.tradeId,
      set: {
        ticker: sql`excluded.ticker`,
        size: sql`excluded.size`,
        tradedAt: sql`excluded.traded_at`,
        entryPrice: sql`excluded.entry_price`,
        takerSide: sql`excluded.taker_side`,
        takerOutcomeSide: sql`excluded.taker_outcome_side`,
        takerBookSide: sql`excluded.taker_book_side`,
        isBlockTrade: sql`excluded.is_block_trade`,
        usdNotional: sql`excluded.usd_notional`,
        category: sql`excluded.category`,
        rawPayload: sql`excluded.raw_payload`,
        createdAt: sql`excluded.created_at`,
      },
    });

  const stakes = rows.map((row) => row.usdNotional ?? 0);
  const evPercents = Array.from({ length: count }, (_, index) => evPercentForIndex(index));

  console.log(`✅ Seeded ${count} Kalshi shadow trades (${SEED_PREFIX}*)`);
  console.log(
    JSON.stringify(
      {
        minStakeUsd: Math.min(...stakes),
        maxStakeUsd: Math.max(...stakes),
        minEvPercent: Math.min(...evPercents),
        maxEvPercent: Math.max(...evPercents),
        newestTradedAt: rows[0]?.tradedAt.toISOString(),
        oldestTradedAt: rows.at(-1)?.tradedAt.toISOString(),
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[seedKalshiTrades] failed:", error);
  process.exit(1);
});
