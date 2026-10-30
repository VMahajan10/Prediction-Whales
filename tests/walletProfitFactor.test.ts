import assert from "node:assert/strict";
import {
  computeCategoryProfitFactorSlice,
  computeWalletProfitFactorStats,
  formatProfitFactorUnavailable,
  formatProfitFactorValue,
  profitFactorExcludingBestTradeSlice,
} from "@/lib/walletProfitFactor";

function runCase(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}`);
    throw e;
  }
}

runCase("PF = gross profit / gross loss", () => {
  const stats = computeWalletProfitFactorStats([
    { realizedPnl: 100, title: "NFL team wins", hasReliableTitle: true },
    { realizedPnl: -50, title: "NFL spread", hasReliableTitle: true },
    { realizedPnl: 80, title: "NBA finals", hasReliableTitle: true },
    { realizedPnl: -20, title: "NBA points", hasReliableTitle: true },
  ]);
  assert.equal(stats.overall.positionCount, 4);
  assert.equal(stats.overall.grossProfit, 180);
  assert.equal(stats.overall.grossLoss, 70);
  assert.ok(stats.overall.profitFactor != null);
  assert.equal(Number(stats.overall.profitFactor?.toFixed(2)), 2.57);
});

runCase("two decimal PF display", () => {
  assert.equal(formatProfitFactorValue(1.456), "1.46");
});

runCase("zero gross loss shows No losses yet", () => {
  assert.equal(formatProfitFactorValue(null), "No losses yet");
  assert.equal(formatProfitFactorUnavailable(), "Not enough history");
  const stats = computeWalletProfitFactorStats([
    { realizedPnl: 10, title: "NFL win", hasReliableTitle: true },
    { realizedPnl: 5, title: "NFL win 2", hasReliableTitle: true },
  ]);
  assert.equal(stats.overall.profitFactor, null);
  assert.equal(stats.overall.grossLoss, 0);
});

runCase("excluding best trade lowers PF", () => {
  const positions = [
    { realizedPnl: 500, title: "NFL jackpot", hasReliableTitle: true },
    { realizedPnl: 50, title: "NFL small", hasReliableTitle: true },
    { realizedPnl: -100, title: "NFL loss", hasReliableTitle: true },
  ];
  const stats = computeWalletProfitFactorStats(positions);
  const exBest = profitFactorExcludingBestTradeSlice(positions);
  assert.ok((stats.overall.profitFactor ?? 0) > (exBest.profitFactor ?? 0));
  assert.equal(exBest.positionCount, 2);
});

runCase("category slice uses badge label", () => {
  const nfl = computeCategoryProfitFactorSlice(
    [
      {
        realizedPnl: 90,
        title: "Will the NFL team cover?",
        hasReliableTitle: true,
      },
      {
        realizedPnl: -30,
        title: "NFL total points",
        hasReliableTitle: true,
      },
      { realizedPnl: 0, title: "NFL push", hasReliableTitle: true },
    ],
    "NFL"
  );
  assert.equal(nfl.categoryLabel, "NFL");
  assert.equal(nfl.positionCount, 3);
  assert.equal(nfl.profitFactor, 3);
  assert.equal(nfl.winCount, 1);
  assert.equal(nfl.lossCount, 1);
  assert.equal(nfl.winRatePct, 50);
});

runCase("untitled positions count in overall but not category buckets", () => {
  const stats = computeWalletProfitFactorStats([
    { realizedPnl: 50, hasReliableTitle: false },
    { realizedPnl: -25, title: "NFL spread", hasReliableTitle: true },
  ]);
  assert.equal(stats.overall.positionCount, 2);
  assert.equal(stats.byCategoryLabel.length, 1);
  assert.equal(stats.byCategoryLabel[0].positionCount, 1);
});

console.log("walletProfitFactor tests passed");
