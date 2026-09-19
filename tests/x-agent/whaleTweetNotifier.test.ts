import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeedTrade } from "@/lib/feedTradeTypes";
import {
  feedTradeToWhaleTrade,
  notifyKalshiFeedTradeIfEligible,
  notifyWhaleTradeIfEligible,
  whaleTradeDedupKey,
} from "@/lib/whaleTweetNotifier";
import { whaleTweetTestHooks } from "@/lib/sendWhaleTweet";
import { MIN_WHALE_USD } from "@/lib/whaleTrades";

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

describe("whaleTweetNotifier", () => {
  let tweetCalls = 0;

  beforeEach(() => {
    process.env.BOT_API_SECRET = "test-secret";
    tweetCalls = 0;
    whaleTweetTestHooks.override = async () => {
      tweetCalls += 1;
      return { ok: true, tweetId: "test-tweet" };
    };
  });

  afterEach(() => {
    whaleTweetTestHooks.override = undefined;
  });

  it("does not tweet Kalshi feed trades", () => {
    notifyKalshiFeedTradeIfEligible(kalshiFeedTrade);
    expect(tweetCalls).toBe(0);
  });

  it("does not tweet Kalshi whale trades", () => {
    const kalshiWhale = feedTradeToWhaleTrade(kalshiFeedTrade);
    notifyWhaleTradeIfEligible(kalshiWhale);
    expect(tweetCalls).toBe(0);
  });

  it("tweets eligible Polymarket whale trades once", () => {
    notifyWhaleTradeIfEligible(polymarketWhale);
    expect(tweetCalls).toBe(1);

    notifyWhaleTradeIfEligible(polymarketWhale);
    expect(tweetCalls).toBe(1);
  });

  it("builds stable dedupe keys", () => {
    expect(
      whaleTradeDedupKey({ source: "kalshi", id: "t1", transactionHash: "" })
    ).toBe("kalshi:t1");
  });
});
