import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SocketTrade } from "@/lib/socketTrade";
import {
  runShadowWorkerTradePipeline,
  socketTradeToWhale,
} from "@/lib/x-agent/runShadowDaemon";

const WALLET = "0xabc123def4567890abcdef1234567890abcdef12";

const mockEnsureHydrated = vi.fn();
const mockResolveWallet = vi.fn();

vi.mock("@/lib/x-agent/walletCredibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/x-agent/walletCredibility")>();
  return {
    ...actual,
    ensureWalletCredibilityHydrated: (...args: unknown[]) =>
      mockEnsureHydrated(...args),
  };
});

vi.mock("@/lib/resolveWhaleWallet", () => ({
  resolveWalletForTrade: (...args: unknown[]) => mockResolveWallet(...args),
}));

const trade: SocketTrade = {
  id: "trade-1",
  title: "Will Bitcoin reach $100k?",
  side: "BUY",
  outcome: "Yes",
  price: 0.5,
  size: 1000,
  usdNotional: 500,
  timestamp: 1_800_000_000,
  transactionHash: "0xhash",
  assetId: "12345",
};

describe("shadow worker trade pipeline sequencing", () => {
  beforeEach(() => {
    mockEnsureHydrated.mockReset();
    mockResolveWallet.mockReset();
    mockResolveWallet.mockResolvedValue({ wallet: WALLET });
    mockEnsureHydrated.mockResolvedValue({
      whale: {
        walletAddress: WALLET,
        hydrationStatus: "complete",
      },
      source: "polymarket_api",
      hydrationStatus: "complete",
    });
  });

  it("hydrates wallet credibility before feed persistence and X-agent processing", async () => {
    const order: string[] = [];
    const persistFeedTrade = vi.fn(async () => {
      order.push("persist");
    });
    const processXAgent = vi.fn(async () => {
      order.push("xagent");
    });

    mockEnsureHydrated.mockImplementation(async () => {
      order.push("hydrate");
      return {
        whale: { walletAddress: WALLET, hydrationStatus: "complete" },
        source: "polymarket_api",
        hydrationStatus: "complete",
      };
    });

    await runShadowWorkerTradePipeline(trade, {
      persistFeedTrade,
      processXAgent,
    });

    expect(order).toEqual(["hydrate", "persist", "xagent"]);
    expect(mockEnsureHydrated).toHaveBeenCalledWith(WALLET, {
      tradeId: trade.id,
    });
  });

  it("first-trade regression: hydration completes before persistFeedTrade gate runs", async () => {
    const persistFeedTrade = vi.fn(async () => undefined);
    const processXAgent = vi.fn(async (_whale, resolution) => {
      expect(resolution).toEqual(
        expect.objectContaining({ hydrationStatus: "complete" })
      );
    });

    await runShadowWorkerTradePipeline(trade, {
      persistFeedTrade,
      processXAgent,
    });

    expect(mockEnsureHydrated).toHaveBeenCalledBefore(persistFeedTrade);
    expect(persistFeedTrade).toHaveBeenCalledBefore(processXAgent);

    const whale = await socketTradeToWhale(trade);
    expect(whale.proxyWallet).toBe(WALLET);
    expect(persistFeedTrade).toHaveBeenCalledWith(
      trade,
      expect.objectContaining({ proxyWallet: WALLET })
    );
  });
});
