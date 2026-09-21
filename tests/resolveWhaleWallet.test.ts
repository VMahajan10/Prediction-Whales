import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  TOPIC_ORDER_FILLED_NEG_RISK,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
} from "@/lib/walletLedger/onchain/contracts";
import {
  resolveTraderFromOrderFilledEvents,
  resolveTraderFromReceiptLogs,
  traderForMatchedFill,
  type ReceiptLog,
} from "@/lib/resolveWhaleWalletEconomic";
import type { ParsedOrderFilled } from "@/lib/walletLedger/onchain/types";
import {
  clearWalletResolutionCache,
  resolveWalletForTrade,
} from "@/lib/resolveWhaleWallet";

const D91 = "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296";
const TRADER = "0xe91171f655be1568e4c63f29663c0028649e3d4e";
const MAKER = "0x3b62c64ebaee15478e8b21765b9f940458655cc8";
const OUTCOME_ASSET = "20430502128363833242947896883530233050893148326040701832019089756354582458135";

function addressTopic(addr: string): string {
  return `0x${addr.slice(2).padStart(64, "0")}`;
}

function uint256Data(words: bigint[]): string {
  return `0x${words.map((w) => w.toString(16).padStart(64, "0")).join("")}`;
}

function negRiskOrderFilledLog(input: {
  maker: string;
  taker: string;
  makerAssetId: bigint;
  takerAssetId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
  logIndex?: number;
}): ReceiptLog {
  return {
    address: NEG_RISK_CTF_EXCHANGE_ADDRESS,
    topics: [
      TOPIC_ORDER_FILLED_NEG_RISK,
      `0x${"11".repeat(32)}`,
      addressTopic(input.maker),
      addressTopic(input.taker),
    ],
    data: uint256Data([
      input.makerAssetId,
      input.takerAssetId,
      input.makerAmount,
      input.takerAmount,
    ]),
    logIndex: `0x${(input.logIndex ?? 1).toString(16)}`,
  };
}

function ctfTransferBatchLogWithD91(): ReceiptLog {
  return {
    address: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
    topics: [
      "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb",
      addressTopic(D91),
      addressTopic(D91),
      addressTopic(D91),
    ],
    data: "0x",
    logIndex: "0x2f",
  };
}

function sampleFill(overrides: Partial<ParsedOrderFilled> = {}): ParsedOrderFilled {
  return {
    kind: "order_filled_neg_risk",
    orderHash: "0xabc",
    maker: MAKER,
    taker: TRADER,
    makerAssetId: "0",
    takerAssetId: OUTCOME_ASSET,
    makerAmountFilled: 500_000_000n,
    takerAmountFilled: 1_000_000_000n,
    blockNumber: 1,
    transactionHash: "0xtx",
    logIndex: 1,
    contractAddress: NEG_RISK_CTF_EXCHANGE_ADDRESS,
    ...overrides,
  };
}

describe("resolveWhaleWalletEconomic", () => {
  it("A: CTF indexed topics alone cannot win trader identity", () => {
    const logs = [ctfTransferBatchLogWithD91(), ctfTransferBatchLogWithD91()];
    const result = resolveTraderFromReceiptLogs(logs, {
      assetId: OUTCOME_ASSET,
      side: "BUY",
    });
    expect(result.wallet).toBeNull();
    expect(result.reason).toBe("no_order_filled");
  });

  it("B: OrderFilled economic participant beats noisy CTF topics", () => {
    const logs = [
      ctfTransferBatchLogWithD91(),
      negRiskOrderFilledLog({
        maker: MAKER,
        taker: TRADER,
        makerAssetId: 0n,
        takerAssetId: BigInt(OUTCOME_ASSET),
        makerAmount: 500_000_000n,
        takerAmount: 1_000_000_000n,
      }),
    ];
    const result = resolveTraderFromReceiptLogs(logs, {
      assetId: OUTCOME_ASSET,
      side: "BUY",
      sizeShares: 1000,
    });
    expect(result.wallet).toBe(TRADER);
    expect(result.reason).toBe("matched_unique_trader");
  });

  it("C: multiple plausible OrderFilled traders => unresolved", () => {
    const events = [
      sampleFill({ taker: TRADER }),
      sampleFill({ taker: "0x204f72f35326db932158cba6adff0b9a1da95e14" }),
    ];
    const result = resolveTraderFromOrderFilledEvents(events, {
      assetId: OUTCOME_ASSET,
      side: "BUY",
    });
    expect(result.wallet).toBeNull();
    expect(result.reason).toBe("ambiguous_traders");
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it("E: no strong evidence => unresolved", () => {
    const result = resolveTraderFromOrderFilledEvents([], {
      assetId: OUTCOME_ASSET,
      side: "BUY",
    });
    expect(result.wallet).toBeNull();
    expect(result.reason).toBe("no_order_filled");
  });

  it("F: d91-style receipt — d91 not selected as trader", () => {
    const logs = [
      ctfTransferBatchLogWithD91(),
      negRiskOrderFilledLog({
        maker: MAKER,
        taker: TRADER,
        makerAssetId: 0n,
        takerAssetId: BigInt(OUTCOME_ASSET),
        makerAmount: 663_000_000n,
        takerAmount: 1_000_000_000n,
      }),
    ];
    const result = resolveTraderFromReceiptLogs(logs, {
      assetId: OUTCOME_ASSET,
      side: "BUY",
      sizeShares: 1000,
    });
    expect(result.wallet).not.toBe(D91);
    expect(result.wallet).toBe(TRADER);
  });

  it("traderForMatchedFill respects BUY vs SELL semantics", () => {
    const buyFill = sampleFill();
    expect(traderForMatchedFill(buyFill, OUTCOME_ASSET, "BUY")).toBe(TRADER);
    const sellFill = sampleFill({
      makerAssetId: OUTCOME_ASSET,
      takerAssetId: "0",
      maker: MAKER,
      taker: TRADER,
    });
    expect(traderForMatchedFill(sellFill, OUTCOME_ASSET, "SELL")).toBe(MAKER);
  });
});

describe("resolveWalletForTrade", () => {
  beforeEach(() => {
    clearWalletResolutionCache();
    vi.restoreAllMocks();
  });

  it("D: trusted API proxyWallet is not overwritten by onchain path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => ({
        result: {
          logs: [
            negRiskOrderFilledLog({
              maker: MAKER,
              taker: TRADER,
              makerAssetId: 0n,
              takerAssetId: BigInt(OUTCOME_ASSET),
              makerAmount: 1n,
              takerAmount: 1n,
            }),
          ],
        },
      }),
    } as Response);

    const apiWallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { wallet, source } = await resolveWalletForTrade("0xdeadbeef", {
      assetId: OUTCOME_ASSET,
      side: "BUY",
      trustedApiProxyWallet: apiWallet,
    });

    expect(wallet).toBe(apiWallet);
    expect(source).toBe("data-api-trusted");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
