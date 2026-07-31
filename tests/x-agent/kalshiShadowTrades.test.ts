import { describe, expect, it } from "vitest";
import {
  buildKalshiShadowTradeRow,
  serializeShadowPayload,
  toShadowFloat,
} from "@/lib/x-agent/kalshiShadowTrades";

describe("kalshi shadow trade row", () => {
  it("maps stream identifiers for internal P&L tracking", () => {
    const row = buildKalshiShadowTradeRow({
      tradeId: "trade-abc",
      ticker: "KXBTC-25DEC31",
      size: 120,
      timestamp: 1_700_000_000,
      entryPrice: 0.42,
      takerSide: "yes",
      takerOutcomeSide: "yes",
      takerBookSide: "bid",
      isBlockTrade: false,
      usdNotional: 50.4,
      rawPayload: { trade_id: "trade-abc" },
    });

    expect(row.tradeId).toBe("trade-abc");
    expect(row.ticker).toBe("KXBTC-25DEC31");
    expect(row.size).toBe(120);
    expect(row.entryPrice).toBe(0.42);
    expect(row.takerSide).toBe("yes");
    expect(row.takerBookSide).toBe("bid");
    expect(row.usdNotional).toBe(50.4);
    expect(row.tradedAt).toEqual(new Date(1_700_000_000_000));
  });

  it("rounds noisy IEEE floats before persistence", () => {
    expect(toShadowFloat(0.9279999999999999)).toBe(0.928);
    expect(
      buildKalshiShadowTradeRow({
        tradeId: "trade-float",
        ticker: "KXTEST",
        size: 0.9279999999999999,
        timestamp: 1_700_000_000,
        entryPrice: 0.42,
        usdNotional: 0.38976,
      }).size
    ).toBe(0.928);
  });

  it("serializes raw payload as JSON-safe objects", () => {
    const payload = serializeShadowPayload({
      trade_id: "abc",
      nested: { count: 3 },
      extra: undefined,
    });

    expect(payload).toEqual({
      trade_id: "abc",
      nested: { count: 3 },
    });
  });

  it("rejects non-finite floats", () => {
    expect(() => toShadowFloat(Number.NaN)).toThrow(/Invalid shadow trade float/);
    expect(() => toShadowFloat(Number.POSITIVE_INFINITY)).toThrow(
      /Invalid shadow trade float/
    );
  });
});
