import assert from "node:assert/strict";
import {
  buildWhaleReceiptData,
  formatAvgEvPercent,
  formatCentsLabel,
  formatUsdStake,
  formatWinRatePercent,
} from "@/lib/x-agent/generateWhaleReceiptPng";

console.log("whaleReceiptImage tests");

assert.equal(formatUsdStake(25000), "$25,000");
assert.equal(formatCentsLabel(64.2), "64¢");
assert.equal(formatWinRatePercent(0.68), "68%");
assert.equal(formatAvgEvPercent(0.125), "+12.5%");
assert.equal(formatAvgEvPercent(-0.02), "-2.0%");

const receipt = buildWhaleReceiptData(
  {
    marketSlug: "will-team-a-win",
    side: "Team A",
    stakeNotional: 50000,
    entryCents: 64,
    nowCents: 71,
    walletAddress: "0xabc123",
  },
  {
    pseudonym: "Sharp Whale",
    winRate: 0.72,
    avgEv: 0.08,
  }
);

assert.equal(receipt.marketTitle, "Will Team A Win");
assert.equal(receipt.outcomeSide, "Team A");
assert.equal(receipt.stakeLabel, "$50,000");
assert.equal(receipt.entryLabel, "64¢");
assert.equal(receipt.nowLabel, "71¢");
assert.equal(receipt.winRateLabel, "72%");
assert.equal(receipt.avgEvLabel, "+8.0%");
assert.equal(receipt.whaleBadge, "Sharp Whale");

console.log("✓ all whaleReceiptImage tests passed");
