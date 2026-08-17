import { describe, expect, it } from "vitest";
import {
  pipelineEvKeyForWhale,
  resolvePipelineEvForWhale,
} from "@/lib/pipelineEvLookupHelpers";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { pipelineEvLookupKeyKalshi } from "@/lib/evPipeline/types";
import type { WhaleTrade } from "@/lib/whaleTrades";

function kalshiWhale(ticker: string): WhaleTrade {
  return {
    id: "k1",
    title: "Fed funds above 3%",
    side: "BUY",
    outcome: "Yes",
    price: 0.42,
    size: 600,
    usdNotional: 600,
    timestamp: 1_700_000_000,
    transactionHash: "",
    source: "kalshi",
    platform: "KALSHI",
    ticker,
    detectedAt: 1_700_000_000_000,
    isLive: true,
  };
}

describe("pipelineEvKeyForWhale", () => {
  it("normalizes kalshi: prefixed tickers like Cross-Venue Lock scanner", () => {
    const key = pipelineEvKeyForWhale(
      kalshiWhale("kalshi:KXFED-26OCT-T3.00")
    );
    expect(key).toBe(pipelineEvLookupKeyKalshi("KXFED-26OCT-T3.00"));
  });

  it("uppercases mixed-case Kalshi tickers", () => {
    const key = pipelineEvKeyForWhale(kalshiWhale("kxfed-26oct-t3.00"));
    expect(key).toBe(pipelineEvLookupKeyKalshi("KXFED-26OCT-T3.00"));
  });
});

describe("resolvePipelineEvForWhale", () => {
  it("resolves KXFED rows via normalized ticker aliases", () => {
    const ticker = "KXFED-26OCT-T3.00";
    const key = pipelineEvLookupKeyKalshi(ticker);
    const entry = {
      key,
      status: "ok",
      kalshiTicker: ticker,
      netEvPercent: 4.2,
    } as PipelineTradeEv;
    const index = new Map([[key, entry]]);

    const hit = resolvePipelineEvForWhale(
      index,
      kalshiWhale("kalshi:kxfed-26oct-t3.00")
    );
    expect(hit?.netEvPercent).toBe(4.2);
  });

  it("synthesizes pipeline EV from stamped trade netEvPercent when index misses", () => {
    const whale = {
      ...kalshiWhale("KXFED-26OCT-T3.00"),
      netEvPercent: 5.1,
    };
    const hit = resolvePipelineEvForWhale(new Map(), whale);
    expect(hit?.netEvPercent).toBe(5.1);
    expect(hit?.status).toBe("ok");
  });
});
