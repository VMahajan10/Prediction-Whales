import assert from "node:assert/strict";
import type { FeedTrade } from "@/lib/kalshiTrades";
import {
  feedTradeToWhaleTrade,
  notifyKalshiFeedTradeIfEligible,
  notifyWhaleTradeIfEligible,
  whaleTradeDedupKey,
} from "@/lib/whaleTweetNotifier";
import { MIN_WHALE_USD } from "@/lib/whaleTrades";

process.env.BOT_API_SECRET = "test-secret";

const kalshiFeedTrade: FeedTrade = {
  id: "trade-kalshi-1",
  source: "kalshi",
  title: "Test market",
  outcome: "Yes",
  side: "BUY",
  price: 0.55,
  size: 1000,
  usdNotional: MIN_WHALE_USD + 100,
  timestamp: Math.floor(Date.now() / 1000),
  traceable: true,
  ticker: "TEST-TICKER",
};

const polymarketWhale = {
  id: "pm-1",
  title: "PM market",
  side: "BUY" as const,
  outcome: "Yes",
  price: 0.6,
  size: MIN_WHALE_USD + 50,
  timestamp: Math.floor(Date.now() / 1000),
  transactionHash: "0xabc",
  proxyWallet: "0xwallet",
  source: "polymarket" as const,
  usdNotional: MIN_WHALE_USD + 50,
  detectedAt: Date.now(),
  isLive: true,
};

let tweetCalls = 0;

(globalThis as { fetch?: typeof fetch }).fetch = async () => {
  tweetCalls += 1;
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

function resetTweetCalls(): void {
  tweetCalls = 0;
}

console.log("whaleTweetNotifier tests");

resetTweetCalls();
notifyKalshiFeedTradeIfEligible(kalshiFeedTrade);
assert.equal(tweetCalls, 0, "Kalshi feed notifier must not tweet");

resetTweetCalls();
const kalshiWhale = feedTradeToWhaleTrade(kalshiFeedTrade);
notifyWhaleTradeIfEligible(kalshiWhale);
assert.equal(tweetCalls, 0, "Kalshi whale trades must not tweet");

resetTweetCalls();
notifyWhaleTradeIfEligible(polymarketWhale);
assert.equal(tweetCalls, 1, "Polymarket whale trades may tweet once");

resetTweetCalls();
notifyWhaleTradeIfEligible(polymarketWhale);
assert.equal(tweetCalls, 0, "Polymarket whale tweets dedupe per trade");

assert.equal(
  whaleTradeDedupKey({ source: "kalshi", id: "t1", transactionHash: "" }),
  "kalshi:t1"
);

console.log("✓ all whaleTweetNotifier tests passed");
