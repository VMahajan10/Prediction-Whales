import { describe, expect, it } from "vitest";
import {
  assignChainEventDedupeKey,
  buildCanonicalChainLogIdentity,
} from "@/lib/walletLedger/canonicalChainIdentity";
import { hashLifecycleInputSequence } from "@/lib/walletLedger/indexed/store/lifecycleInputHash";
import {
  matchClassDEventToReceipt,
} from "@/lib/walletLedger/indexed/store/classDRecovery";
import { assessUnresolvedChainOrder } from "@/lib/walletLedger/indexed/store/unresolvedChainOrder";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { decodeOrderFilledV1 } from "@/lib/walletLedger/onchain/decode";
import { orderFilledToLedgerEvents } from "@/lib/walletLedger/onchain/normalize";
import {
  TOPIC_ORDER_FILLED_V1,
} from "@/lib/walletLedger/onchain/contracts";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";
import type {
  PositionLifecycle,
  WalletLedgerEvent,
} from "@/lib/walletLedger/types";

const WALLET = "0xabc0000000000000000000000000000000000001";
const MAKER = "0xdef0000000000000000000000000000000000002";
const TAKER = WALLET;

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

function receiptMatchedEvent(
  overrides: Partial<WalletLedgerEvent> = {}
): WalletLedgerEvent {
  const parsed = decodeOrderFilledV1(orderFilledLog())!;
  const [decoded] = orderFilledToLedgerEvents(parsed, WALLET, 1_700_000_000);
  const { logIndex: _ignored, ...withoutLogIndex } = decoded;
  return assignChainEventDedupeKey({
    ...withoutLogIndex,
    logIndex: undefined,
    ...overrides,
  });
}

function positionLifecycle(
  overrides: Partial<PositionLifecycle> = {}
): PositionLifecycle {
  return {
    conditionId: "0xcond",
    asset: "0xasset",
    lifecycleEpisode: 0,
    completed: true,
    fullyExited: true,
    heldThroughResolution: false,
    completionReason: "fully_exited",
    capitalAtRisk: 100,
    grossBuyCash: 100,
    grossSellCash: 120,
    realizedPnl: 20,
    positionRoi: 0.2,
    netShares: 0,
    firstEntryAt: 1,
    lastActivityAt: 2,
    excludedFromMetrics: false,
    events: [],
    ...overrides,
  };
}

const gammaCoverage = {
  distinctMarkets: 1,
  marketsFoundBefore: 1,
  marketsFoundAfter: 1,
  resolvedBefore: 0,
  resolvedAfter: 0,
  coverageBeforePct: 1,
  coverageAfterPct: 1,
  marketFoundCoverageAfterPct: 1,
};

describe("class-D recovery + unresolved chain order validity", () => {
  it("A: unresolved chain event in lifecycle => credibilityMetricsValid=false", () => {
    const event = receiptMatchedEvent({ type: "BUY", asset: "asset-1", shares: 100, cashUsd: 50 });
    const assessment = assessUnresolvedChainOrder([event]);
    expect(assessment.unresolvedChainEventsInLifecycle).toBe(1);
    expect(assessment.blocksCredibility).toBe(true);

    const metrics = computeWalletLedgerMetrics({
      positions: [positionLifecycle()],
      identity: {
        confidence: "high",
        resolutionMethod: "proxy_wallet_direct",
        positionsOnlyMismatch: false,
      },
      activityTruncated: false,
      tradesTruncated: false,
      rawEventCount: 1,
      deduplicatedEventCount: 1,
      gammaCoverage,
      mergeSplit: analyzeMergeSplitImpact([positionLifecycle()]),
      hasHistoryEvents: true,
      unresolvedChainOrderBlocksCredibility: assessment.blocksCredibility,
      unresolvedChainEvents: assessment.unresolvedChainEvents,
      unresolvedChainEventsInLifecycle:
        assessment.unresolvedChainEventsInLifecycle,
      affectedPositionGroups: assessment.affectedPositionGroups,
    });

    expect(metrics.credibilityMetricsValid).toBe(false);
    expect(metrics.historyValidity).toBe("partial-and-metrics-unsafe");
    expect(metrics.historyCompletenessReasons).toContain("unresolved_chain_order");
  });

  it("B: receipt uniquely resolves logIndex => canonical identity assigned", () => {
    const event = receiptMatchedEvent();
    const match = matchClassDEventToReceipt({
      event,
      receiptLogs: [orderFilledLog({ logIndex: "0x2a" })],
    });
    expect(match.outcome).toBe("unique_match");
    expect(match.recoveredLogIndex).toBe(42);
    expect(match.canonicalIdentity).toBe(
      buildCanonicalChainLogIdentity({
        txHash: event.txHash!,
        logIndex: 42,
      })
    );
  });

  it("C: multiple matching receipt logs => unresolved, no guess", () => {
    const event = receiptMatchedEvent();
    const match = matchClassDEventToReceipt({
      event,
      receiptLogs: [
        orderFilledLog({ logIndex: "0x1" }),
        orderFilledLog({ logIndex: "0x2" }),
      ],
    });
    expect(match.outcome).toBe("unresolved_ambiguous_receipt_match");
    expect(match.recoveredLogIndex).toBeUndefined();
  });

  it("D: no matching receipt log => unresolved", () => {
    const event = receiptMatchedEvent({ shares: 999, cashUsd: 999 });
    const match = matchClassDEventToReceipt({
      event,
      receiptLogs: [orderFilledLog()],
    });
    expect(match.outcome).toBe("unresolved_no_receipt_match");
  });

  it("E: same-wallet recovered event matches existing canonical event => reconcilable", async () => {
    const {
      createEmptyReconciliationDiagnostics,
      reconcileAuthoritativeEventBeforeInsert,
    } = await import(
      "@/lib/walletLedger/indexed/store/canonicalEventReconciliation"
    );
    const wallet = WALLET.toLowerCase();
    const canonical = assignChainEventDedupeKey({
      ...receiptMatchedEvent(),
      logIndex: 42,
    });
    const canonicalIdentity = buildCanonicalChainLogIdentity({
      txHash: "0xhash",
      logIndex: 42,
    });
    const index = {
      mergeKeys: new Set<string>(),
      byDedupeKey: new Map(),
      byCanonicalIdentity: new Map([
        [
          canonicalIdentity,
          {
            id: 1,
            dedupeKey: "other-dedupe",
            canonicalIdentity,
            txHash: "0xhash",
            logIndex: 42,
            blockNumber: 100,
            eventType: canonical.type,
            assetId: canonical.asset,
            shares: canonical.shares,
            cashUsd: canonical.cashUsd,
            source: "polygon",
            walletAddress: wallet,
          },
        ],
      ]),
      byPhysicalLog: new Map(),
    };
    const recovered = { ...receiptMatchedEvent(), logIndex: 42 };
    const diagnostics = createEmptyReconciliationDiagnostics();
    const outcome = await reconcileAuthoritativeEventBeforeInsert(
      wallet,
      recovered,
      index,
      diagnostics
    );
    expect(outcome.kind).not.toBe("economic_conflict");
  });

  it("F: recovered logIndex preserves lifecycle sequence when uniquely orderable", () => {
    const unresolved = receiptMatchedEvent({ dedupeKey: "legacy-key" });
    const recovered = { ...unresolved, logIndex: 42 };
    const before = hashLifecycleInputSequence([unresolved]);
    const after = hashLifecycleInputSequence([recovered]);
    expect(after.count).toBe(before.count);
  });

  it("G: all lifecycle-relevant unresolved events recovered => metrics-safe validity can return", () => {
    const resolved = assignChainEventDedupeKey({
      ...receiptMatchedEvent(),
      logIndex: 7,
    });
    const assessment = assessUnresolvedChainOrder([resolved]);
    expect(assessment.unresolvedChainEventsInLifecycle).toBe(0);
    expect(assessment.blocksCredibility).toBe(false);

    const metrics = computeWalletLedgerMetrics({
      positions: [positionLifecycle()],
      identity: {
        confidence: "high",
        resolutionMethod: "proxy_wallet_direct",
        positionsOnlyMismatch: false,
      },
      activityTruncated: false,
      tradesTruncated: false,
      rawEventCount: 1,
      deduplicatedEventCount: 1,
      gammaCoverage,
      mergeSplit: analyzeMergeSplitImpact([positionLifecycle()]),
      hasHistoryEvents: true,
      unresolvedChainOrderBlocksCredibility: assessment.blocksCredibility,
    });
    expect(metrics.credibilityMetricsValid).toBe(true);
    expect(metrics.historyValidity).toBe("complete");
  });
});
