import assert from "node:assert/strict";
import type { WalletProfitFactorStats } from "@/lib/walletProfitFactor";
import {
  getCachedWalletProfitFactorStats,
  invalidateWalletProfitFactorStatsCache,
  peekMemoryWalletProfitFactorStats,
  setCachedWalletProfitFactorStats,
} from "@/lib/polymarketDataApi/profitFactorStatsCache";

function verifiedStub(): WalletProfitFactorStats {
  return {
    availability: "verified",
    verified: true,
    overall: {
      categoryLabel: "All",
      positionCount: 10,
      grossProfit: 100,
      grossLoss: 50,
      profitFactor: 2,
      profitFactorExBest: null,
      limitedData: false,
      winCount: 6,
      lossCount: 4,
      winRatePct: 60,
    },
    excludingBestTrade: null,
    byCategoryLabel: [],
    netRealizedPnl: 50,
    headlineRealizedPnl: 50,
    reconciliationGapPct: 0,
    closedWinCount: 6,
    closedLossCount: 4,
    winRatePct: 60,
  };
}

async function runCase(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    throw e;
  }
}

const wallet = "0xabc123";

async function main() {
  await runCase("memory peek returns stats within TTL", async () => {
    invalidateWalletProfitFactorStatsCache(wallet);
    await setCachedWalletProfitFactorStats(wallet, verifiedStub(), 1000);
    const hot = peekMemoryWalletProfitFactorStats(wallet);
    assert.equal(hot?.winRatePct, 60);
  });

  await runCase("cache hit when syncUpdatedAt matches", async () => {
    invalidateWalletProfitFactorStatsCache(wallet);
    const stats = verifiedStub();
    await setCachedWalletProfitFactorStats(wallet, stats, 1000);
    const hit = await getCachedWalletProfitFactorStats(wallet, 1000);
    assert.equal(hit?.winRatePct, 60);
  });

  await runCase("cache miss when sync state changes", async () => {
    invalidateWalletProfitFactorStatsCache(wallet);
    await setCachedWalletProfitFactorStats(wallet, verifiedStub(), 1000);
    const miss = await getCachedWalletProfitFactorStats(wallet, 2000);
    assert.equal(miss, null);
  });

  console.log("profitFactorStatsCache tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
