import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = join(__dirname, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

vi.mock("server-only", () => ({}));

const scheduleFromHistory = vi.fn();
vi.mock("@/lib/feed/persistProductFeedTradeEligibility", () => ({
  schedulePersistProductFeedTradeEligibilityFromFeedHistory: (
    ...args: unknown[]
  ) => scheduleFromHistory(...args),
  schedulePersistProductFeedTradeEligibility: vi.fn(),
}));

const insertMock = vi.fn();
vi.mock("@/lib/crossmarket/store/db", () => ({
  isDatabaseEnabled: () => true,
  getDb: () => ({
    insert: insertMock.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  }),
}));

vi.mock("@/lib/categorizer", () => ({
  categorizeMarket: vi.fn(async () => "politics"),
}));

vi.mock("@/lib/feedQualificationServer", () => ({
  qualifyWalletsForFeed: vi.fn(async (wallets: string[]) => {
    const map: Record<string, Record<string, unknown>> = {};
    for (const wallet of wallets) {
      map[wallet] = {
        qualified: true,
        hydrationState: "complete",
        resolvedBetsCount: 12,
        resolvedVolumeUSD: 50_000,
        historicalResolvedVolumeTrusted: true,
        historicalVolumeGateReason: null,
        historicalVolumeUsd: 50_000,
        historicalVolumeTrusted: true,
        historicalVolumeReason: null,
        productFeedWalletBlockReason: null,
        identity: { walletAddress: wallet },
        avgStakeNotional: 500,
        avgEv: 0.05,
      };
    }
    return map;
  }),
}));

import { recordFeedTradeHistory } from "@/lib/feed/feedTradeHistory";
import {
  MIN_FEED_TRADE_EV_PCT,
  MIN_PRODUCT_FEED_STAKE_USD,
} from "@/lib/feedQualification";

describe("productFeedTrackingCoverage", () => {
  beforeEach(() => {
    scheduleFromHistory.mockClear();
    insertMock.mockClear();
  });

  it("documents user-visible Polymarket feed entry paths", () => {
    const paths = [
      "app/api/feed/route.ts",
      "app/api/trades/recent/route.ts",
      "lib/useLiveFeed.ts",
      "lib/useWhaleFeed.ts",
      "app/api/trades/route.ts",
    ];
    for (const path of paths) {
      expect(readRepoFile(path).length).toBeGreaterThan(0);
    }
  });

  it("feed_trades inserts are centralized in recordFeedTradeHistory", () => {
    const history = readRepoFile("lib/feed/feedTradeHistory.ts");
    expect(history).toContain('.insert(feedTrades)');
    expect(readRepoFile("lib/x-agent/runShadowDaemon.ts")).toContain(
      "recordFeedTradeHistory"
    );
    expect(readRepoFile("app/api/feed/route.ts")).toContain(
      "recordFeedTradeHistory"
    );
  });

  it("instrumented qualification hooks include collect, filter, and feed history write", () => {
    const server = readRepoFile("lib/feedQualificationServer.ts");
    expect(server).toContain("schedulePersistProductFeedTradeEligibility");
    const history = readRepoFile("lib/feed/feedTradeHistory.ts");
    expect(history).toContain(
      "schedulePersistProductFeedTradeEligibilityFromFeedHistory"
    );
  });

  it("runShadowDaemon does not call product-feed eligibility persistence directly", () => {
    const shadow = readRepoFile("lib/x-agent/runShadowDaemon.ts");
    expect(shadow).not.toContain("schedulePersistProductFeedTradeEligibility");
    expect(shadow).not.toContain("feed_trade_eligibility");
  });

  it("recordFeedTradeHistory schedules at-trade-time eligibility before feed_trades write", async () => {
    await recordFeedTradeHistory([
      {
        id: "socket-trade-1",
        title: "Will Bitcoin reach $100k by end of year?",
        timestamp: 1_758_000_000,
        stakeAmountUsd: MIN_PRODUCT_FEED_STAKE_USD + 100,
        averageEvPercent: MIN_FEED_TRADE_EV_PCT + 1,
        proxyWallet: "0xabc",
        payload: {
          id: "socket-trade-1",
          title: "Will Bitcoin reach $100k by end of year?",
          outcome: "Yes",
          side: "BUY",
          price: 0.5,
          size: 2000,
          slug: "btc-100k",
        },
      },
    ]);

    expect(scheduleFromHistory).toHaveBeenCalledTimes(1);
    const [trades, qualifications] = scheduleFromHistory.mock.calls[0] as [
      { id: string }[],
      Record<string, unknown>,
    ];
    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe("socket-trade-1");
    expect(qualifications["0xabc"]).toBeDefined();
    expect(insertMock).toHaveBeenCalled();
  });

  it("sub-threshold trades skip recordFeedTradeHistory and eligibility persistence", async () => {
    await recordFeedTradeHistory([
      {
        id: "too-small",
        title: "Small stake",
        timestamp: 1_758_000_000,
        stakeAmountUsd: MIN_PRODUCT_FEED_STAKE_USD - 1,
        averageEvPercent: MIN_FEED_TRADE_EV_PCT + 1,
        proxyWallet: "0xabc",
        payload: { id: "too-small", price: 0.5, size: 10 },
      },
    ]);
    expect(scheduleFromHistory).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });
});
