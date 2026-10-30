#!/usr/bin/env tsx
/** Times each server step behind trade detail + trader profile loads. */
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  computeClvStats,
  fetchClosedPositions,
  fetchEventCategories,
  fetchTradesFromDataApi,
  fetchWalletPositions,
} from "@/lib/polymarket";
import { computeCrossMarketEvStats } from "@/lib/crossMarketEvStats";
import { resolvePolymarketTradeDetail } from "@/lib/trades/resolveTradeByHash";
import { enrichTradesWithWhaleAlias } from "@/lib/trades/getTrades";
import { resolveWalletProfitFactorStats } from "@/lib/polymarketDataApi/profitFactorService";
import { computeWalletProfitFactorStatsFromDb } from "@/lib/polymarketDataApi/computeWalletProfitFactorFromDb";
import { loadWalletApiSyncState } from "@/lib/polymarketDataApi/positionsStore";

const WALLET_SYNCED = "0xad529df14c293d77984a0137990a1441b25211ac";

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const r = await fn();
    console.log(`${label.padEnd(48)} ${(performance.now() - t0).toFixed(0).padStart(7)} ms`);
    return r;
  } catch (e) {
    console.log(`${label.padEnd(48)} ${(performance.now() - t0).toFixed(0).padStart(7)} ms  ERROR ${(e as Error).message}`);
    throw e;
  }
}

async function main() {
  const db = getDb();

  console.log("\n== feed_trades hash lookup ==");
  const count = await db.execute(sql`SELECT COUNT(*)::int AS n FROM feed_trades`);
  console.log("feed_trades rows:", (count.rows[0] as { n: number }).n);
  const sample = await db.execute(
    sql`SELECT transaction_hash FROM feed_trades WHERE transaction_hash IS NOT NULL ORDER BY traded_at DESC LIMIT 1`
  );
  const feedHash = (sample.rows[0] as { transaction_hash?: string } | undefined)?.transaction_hash ?? "";
  const plan = await db.execute(
    sql`EXPLAIN ANALYZE SELECT * FROM feed_trades WHERE lower(transaction_hash) = ${feedHash.toLowerCase()} LIMIT 1`
  );
  for (const r of plan.rows as { "QUERY PLAN": string }[]) console.log("  ", r["QUERY PLAN"]);

  console.log("\n== trade detail (/api/trades/[hash]) ==");
  const live = await time("Data API /trades poll (uncached)", () => fetchTradesFromDataApi());
  const liveHash = live[0]?.transactionHash ?? "";
  await time("resolveTradeDetail live hash (cold)", () => resolvePolymarketTradeDetail(liveHash));
  await time("resolveTradeDetail live hash (warm)", () => resolvePolymarketTradeDetail(liveHash));
  if (feedHash) await time("resolveTradeDetail feed hash (cold)", () => resolvePolymarketTradeDetail(feedHash));
  const missing = "0x" + "ab".repeat(32);
  await time("resolveTradeDetail unknown hash (1st)", () => resolvePolymarketTradeDetail(missing));
  await time("resolveTradeDetail unknown hash (2nd)", () => resolvePolymarketTradeDetail(missing));
  await time("enrichTradesWithWhaleAlias (20 trades)", () =>
    enrichTradesWithWhaleAlias(live.map((t) => ({ ...t, source: "polymarket" as const })))
  );

  await time("enrichTradesWithWhaleAlias (2nd call)", () =>
    enrichTradesWithWhaleAlias(live.map((t) => ({ ...t, source: "polymarket" as const })))
  );

  console.log("\n== trader profile (/api/whale-track-record) pieces ==");
  const closed = await time("fetchClosedPositions", () => fetchClosedPositions(WALLET_SYNCED));
  await time("fetchWalletPositions", () => fetchWalletPositions(WALLET_SYNCED));
  const slugs = closed.map((p: { eventSlug?: string }) => p.eventSlug).filter(Boolean) as string[];
  await time(`fetchEventCategories (${new Set(slugs).size} slugs)`, () => fetchEventCategories(slugs));
  await time(`computeClvStats (${closed.length} closed)`, () => computeClvStats(closed));
  await time("computeCrossMarketEvStats", () => computeCrossMarketEvStats(closed, []));

  await time("computeCrossMarketEvStats (2nd call)", () => computeCrossMarketEvStats(closed, []));

  console.log("\n== full profile build (/api/whale-track-record miss) ==");
  const { buildWhaleTrackRecordWithPf } = await import("@/lib/buildWhaleTrackRecordWithPf");
  await time("buildWhaleTrackRecordWithPf", () => buildWhaleTrackRecordWithPf(WALLET_SYNCED));

  const unsynced = await db.execute(sql`
    SELECT r.wallet_address FROM whale_registry r
    LEFT JOIN wallet_api_sync_state s ON s.wallet_address = r.wallet_address
    WHERE s.wallet_address IS NULL AND r.wallet_address <> '0x0000000000000000000000000000000000000000'
    LIMIT 1`);
  const fresh = (unsynced.rows[0] as { wallet_address?: string } | undefined)?.wallet_address;
  if (fresh) {
    const s = await time(`PF never-synced wallet ${fresh.slice(0, 10)}`, () =>
      resolveWalletProfitFactorStats(fresh)
    );
    console.log("   availability:", s.availability);
  }

  console.log("\n== PF stats ==");
  await time("loadWalletApiSyncState", () => loadWalletApiSyncState(WALLET_SYNCED));
  await time("computeWalletProfitFactorStatsFromDb", () => computeWalletProfitFactorStatsFromDb(WALLET_SYNCED));
  await time("resolveWalletProfitFactorStats (cold)", () => resolveWalletProfitFactorStats(WALLET_SYNCED));
  await time("resolveWalletProfitFactorStats (warm)", () => resolveWalletProfitFactorStats(WALLET_SYNCED));

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
