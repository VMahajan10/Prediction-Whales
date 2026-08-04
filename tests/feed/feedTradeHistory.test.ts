import { describe, expect, it } from "vitest";
import {
  buildFeedTradeRow,
  isRecordableFeedTrade,
} from "@/lib/feed/feedTradeHistoryCore";
import { retainLastNonEmpty } from "@/lib/feed/feedRetention";
import {
  MIN_FEED_TRADE_EV_PCT,
  MIN_PRODUCT_FEED_STAKE_USD,
} from "@/lib/feedQualification";

describe("feedTradeHistory", () => {
  it("records only trades meeting the product feed floor", () => {
    expect(
      isRecordableFeedTrade({
        id: "t1",
        title: "Test market",
        timestamp: 1_700_000_000,
        stakeAmountUsd: MIN_PRODUCT_FEED_STAKE_USD,
        averageEvPercent: MIN_FEED_TRADE_EV_PCT,
        payload: { id: "t1" },
      })
    ).toBe(true);

    expect(
      isRecordableFeedTrade({
        id: "t2",
        title: "Too small",
        timestamp: 1_700_000_000,
        stakeAmountUsd: MIN_PRODUCT_FEED_STAKE_USD - 1,
        averageEvPercent: MIN_FEED_TRADE_EV_PCT,
        payload: {},
      })
    ).toBe(false);

    expect(
      isRecordableFeedTrade({
        id: "t3",
        title: "Too low EV",
        timestamp: 1_700_000_000,
        stakeAmountUsd: MIN_PRODUCT_FEED_STAKE_USD,
        averageEvPercent: MIN_FEED_TRADE_EV_PCT - 0.1,
        payload: {},
      })
    ).toBe(false);
  });

  it("builds a feed_trades row from product feed input", () => {
    const row = buildFeedTradeRow({
      id: "trade-1",
      transactionHash: "0xabc",
      proxyWallet: "0xABC",
      title: "Will Bitcoin reach $100k?",
      timestamp: 1_700_000_000,
      stakeAmountUsd: 750,
      averageEvPercent: 4.2,
      payload: { id: "trade-1", netEvPercent: 4.2 },
    });

    expect(row.tradeId).toBe("trade-1");
    expect(row.proxyWallet).toBe("0xabc");
    expect(row.stakeAmount).toBe(750);
    expect(row.averageEv).toBe(4.2);
    expect(row.tradedAt).toEqual(new Date(1_700_000_000_000));
  });
});

describe("feedRetention", () => {
  it("keeps the previous array when the next fetch is empty", () => {
    const previous = [{ id: "a" }, { id: "b" }];
    expect(retainLastNonEmpty([], previous)).toEqual(previous);
    expect(retainLastNonEmpty([{ id: "c" }], previous)).toEqual([{ id: "c" }]);
    expect(retainLastNonEmpty([], [])).toEqual([]);
  });
});
