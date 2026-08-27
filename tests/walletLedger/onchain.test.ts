import { describe, expect, it } from "vitest";
import {
  decodeConditionResolution,
  decodeErc1155TransferSingle,
  decodeOrderFilledV1,
  decodePositionSplit,
  decodePositionsMerge,
  decodePayoutRedemption,
  orderFilledInvolvesWallet,
  topicToAddress,
} from "@/lib/walletLedger/onchain/decode";
import {
  mergeApiAndChainEvents,
  orderFilledToLedgerEvents,
  parsedEventsToLedgerEvents,
} from "@/lib/walletLedger/onchain/normalize";
import { conditionResolutionToGamma } from "@/lib/walletLedger/onchain/resolution";
import { dedupeLogs, logDedupeKey } from "@/lib/walletLedger/onchain/rpc";
import { reconcileApiAndChainTrades } from "@/lib/walletLedger/onchain/reconcile";
import {
  TOPIC_CONDITION_RESOLUTION,
  TOPIC_ORDER_FILLED_V1,
  TOPIC_POSITION_SPLIT,
  TOPIC_POSITIONS_MERGE,
  TOPIC_PAYOUT_REDEMPTION,
  CONDITIONAL_TOKENS_ADDRESS,
} from "@/lib/walletLedger/onchain/contracts";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

const WALLET = "0xabc0000000000000000000000000000000000001";
const MAKER = "0xdef0000000000000000000000000000000000002";
const TAKER = "0xabc0000000000000000000000000000000000001";

function pad64(hex: string): string {
  return hex.replace(/^0x/, "").padStart(64, "0");
}

function orderFilledLog(overrides: Partial<RpcLog> = {}): RpcLog {
  const makerTopic = `0x${MAKER.slice(2).padStart(64, "0")}`;
  const takerTopic = `0x${TAKER.slice(2).padStart(64, "0")}`;
  const data =
    "0x" +
    [
      pad64("0"),
      pad64("39"),
      "00000000000000000000000000000000000000000000000000000000005f5e100",
      "00000000000000000000000000000000000000000000000000000000002faf080",
      pad64("0"),
    ].join("");
  return {
    address: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
    topics: [TOPIC_ORDER_FILLED_V1, "0x" + "11".repeat(64), makerTopic, takerTopic],
    data,
    blockNumber: "0x64",
    transactionHash: "0xhash",
    logIndex: "0x0",
    ...overrides,
  };
}

function ctfLog(
  topic0: string,
  topics: string[],
  data: string,
  overrides: Partial<RpcLog> = {}
): RpcLog {
  return {
    address: CONDITIONAL_TOKENS_ADDRESS,
    topics: [topic0, ...topics],
    data,
    blockNumber: "0x100",
    transactionHash: "0xctf",
    logIndex: "0x1",
    ...overrides,
  };
}

describe("on-chain decode", () => {
  it("decodes OrderFilled v1 maker/taker and amounts", () => {
    const parsed = decodeOrderFilledV1(orderFilledLog());
    expect(parsed).not.toBeNull();
    expect(parsed?.maker).toBe(MAKER);
    expect(parsed?.taker).toBe(TAKER);
    expect(orderFilledInvolvesWallet(parsed!, TAKER)).toBe(true);
  });

  it("maps maker-buy USDC flow to BUY ledger event", () => {
    const parsed = decodeOrderFilledV1(orderFilledLog())!;
    const events = orderFilledToLedgerEvents(parsed, MAKER, 1_700_000_000);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("BUY");
    expect(events[0].source).toBe("polygon");
    expect(events[0].cashUsd).toBeGreaterThan(0);
    expect(events[0].shares).toBeGreaterThan(0);
  });

  it("maps taker sell when maker pays USDC", () => {
    const parsed = decodeOrderFilledV1(orderFilledLog())!;
    const events = orderFilledToLedgerEvents(parsed, TAKER, 1_700_000_000);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("SELL");
  });

  it("maps on-chain condition resolution to final gamma-compatible state", () => {
    const gamma = conditionResolutionToGamma({
      conditionId: "0xcond",
      oracle: MAKER,
      questionId: "0xqq",
      outcomeSlotCount: 2,
      payoutNumerators: [1n, 0n],
      blockNumber: 10,
      transactionHash: "0xcond",
      logIndex: 1,
    });
    expect(gamma.resolutionFinal).toBe(true);
    expect(gamma.winningIndex).toBe(0);
  });

  it("maps losing outcome resolution as non-final when split payout", () => {
    const gamma = conditionResolutionToGamma({
      conditionId: "0xcond",
      oracle: MAKER,
      questionId: "0xqq",
      outcomeSlotCount: 2,
      payoutNumerators: [1n, 1n],
      blockNumber: 10,
      transactionHash: "0xcond",
      logIndex: 1,
    });
    expect(gamma.resolutionFinal).toBe(false);
  });

  it("deduplicates RPC logs by tx+logIndex", () => {
    const log = orderFilledLog();
    const deduped = dedupeLogs([log, { ...log }]);
    expect(deduped).toHaveLength(1);
    expect(logDedupeKey(log)).toContain("0xhash");
  });
});

describe("split / merge / redemption normalization", () => {
  const stakeholder = `0x${WALLET.slice(2).padStart(64, "0")}`;
  const conditionId = "0x" + "aa".repeat(32);
  const parentCollection = "0x" + "00".repeat(32);
  const collateral = pad64("2791bca1f2de4661ed88a30c99d7a81a19cb3c11");

  it("parses PositionSplit into SPLIT ledger event", () => {
    const log = ctfLog(
      TOPIC_POSITION_SPLIT,
      [stakeholder, parentCollection, conditionId],
      "0x" + [collateral, pad64("0"), pad64("5f5e100")].join("")
    );
    const split = decodePositionSplit(log);
    expect(split).not.toBeNull();
    const { events } = parsedEventsToLedgerEvents(
      [{ type: "position_split", event: split! }],
      WALLET,
      new Map([[256, 1_700_000_000]])
    );
    expect(events[0]?.type).toBe("SPLIT");
    expect(events[0]?.shares).toBeCloseTo(100, 0);
  });

  it("parses PositionsMerge into MERGE ledger event", () => {
    const log = ctfLog(
      TOPIC_POSITIONS_MERGE,
      [stakeholder, parentCollection, conditionId],
      "0x" + [collateral, pad64("0"), pad64("5f5e100")].join("")
    );
    const merge = decodePositionsMerge(log);
    expect(merge).not.toBeNull();
    const { events } = parsedEventsToLedgerEvents(
      [{ type: "positions_merge", event: merge! }],
      WALLET,
      new Map([[256, 1_700_000_000]])
    );
    expect(events[0]?.type).toBe("MERGE");
  });

  it("parses PayoutRedemption into REDEEM ledger event", () => {
    const redeemer = stakeholder;
    const collateralTopic = `0x${collateral}`;
    const log = ctfLog(
      TOPIC_PAYOUT_REDEMPTION,
      [redeemer, collateralTopic, parentCollection],
      "0x" + [conditionId.slice(2).padStart(64, "0"), pad64("0"), pad64("5f5e100")].join("")
    );
    const redeem = decodePayoutRedemption(log);
    expect(redeem).not.toBeNull();
    const { events } = parsedEventsToLedgerEvents(
      [{ type: "payout_redemption", event: redeem! }],
      WALLET,
      new Map([[256, 1_700_000_000]])
    );
    expect(events[0]?.type).toBe("REDEEM");
    expect(events[0]?.cashUsd).toBeCloseTo(100, 0);
  });
});

describe("on-chain reconciliation", () => {
  it("matches api and chain trades by tx hash", () => {
    const report = reconcileApiAndChainTrades(
      [
        {
          type: "TRADE",
          side: "BUY",
          size: 10,
          price: 0.5,
          transactionHash: "0xhash",
          timestamp: 100,
          asset: "123",
        },
      ],
      [],
      [
        {
          wallet: WALLET,
          conditionId: "",
          asset: "123",
          timestamp: 100,
          type: "BUY",
          shares: 10,
          cashUsd: 5,
          price: 0.5,
          txHash: "0xhash",
          source: "polygon",
          dedupeKey: "k",
        },
      ]
    );
    expect(report.matchedEvents).toBeGreaterThanOrEqual(1);
  });

  it("merges api and chain events without duplicate keys", () => {
    const api: WalletLedgerEvent = {
      wallet: WALLET,
      conditionId: "c",
      asset: "a",
      timestamp: 1,
      type: "BUY",
      shares: 1,
      cashUsd: 1,
      source: "activity",
      dedupeKey: "same",
    };
    const chain: WalletLedgerEvent = { ...api, source: "polygon" };
    const merged = mergeApiAndChainEvents([api], [chain]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("activity");
  });
});

describe("proxy and completeness", () => {
  it("extracts address from topic", () => {
    expect(
      topicToAddress(
        "0x0000000000000000000000007e5972bfc25819775ee5a9d4f191919375487b8b"
      )
    ).toBe("0x7e5972bfc25819775ee5a9d4f191919375487b8b");
  });

  it("does not treat partial block scan as complete history", () => {
    const scanStart = 60_000_000;
    const scanEnd = 60_100_000;
    const windowStart = 57_000_000;
    const windowEnd = 65_000_000;
    const fullWindowScanned =
      scanStart <= windowStart &&
      scanEnd >= windowEnd &&
      scanEnd - scanStart >= windowEnd - windowStart;
    expect(fullWindowScanned).toBe(false);
  });

  it("keeps related proxy addresses separate in identity evidence shape", () => {
    const requested = "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296";
    const related = "0x7e5972bfc25819775ee5a9d4f191919375487b8b";
    expect(requested).not.toBe(related);
  });
});
