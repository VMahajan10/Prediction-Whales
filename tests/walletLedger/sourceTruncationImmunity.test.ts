import { describe, expect, it } from "vitest";
import {
  computeSourceBoundaryStats,
  resolveSourceSpecificTruncationFlags,
} from "@/lib/walletLedger/indexed/sourceTruncationImmunity";
import { resolveAdaptiveFromBlock } from "@/lib/walletLedger/indexed/adaptiveStartBlock";
import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function event(timestamp: number): WalletLedgerEvent {
  return {
    wallet: "0xd27cc742d023d06ef633a4c880cf1ff1836ec081",
    conditionId: "c",
    asset: "a",
    timestamp,
    type: "BUY",
    dedupeKey: `k-${timestamp}`,
    source: "polygon",
  };
}

describe("source-specific truncation immunity", () => {
  const activityBoundary = 1_785_602_421; // Aug 2026
  const tradesBoundary = 1_694_727_428; // Sep 2023
  const indexedMay2024 = 1_716_117_635;

  it("A: activity truncated, trades complete and older — activity immunity PASS", () => {
    const events = [
      event(indexedMay2024),
      event(activityBoundary - 100),
    ];
    const boundaries = computeSourceBoundaryStats(
      events,
      activityBoundary,
      tradesBoundary
    );
    expect(boundaries.eventsBeforeActivityBoundary).toBeGreaterThan(0);
    expect(boundaries.activityExtendsBeforeBoundary).toBe(true);
    expect(boundaries.eventsBeforeTradesBoundary).toBe(0);
    expect(boundaries.tradesExtendsBeforeBoundary).toBe(false);

    const flags = resolveSourceSpecificTruncationFlags({
      apiActivityTruncated: true,
      apiTradesTruncated: false,
      oldestActivityTimestamp: activityBoundary,
      oldestTradesTimestamp: tradesBoundary,
      runSourceBoundaries: boundaries,
    });

    expect(flags.activityTruncationImmune).toBe(true);
    expect(flags.activityTruncated).toBe(false);
    expect(flags.tradesTruncationImmune).toBe(true);
    expect(flags.tradesTruncated).toBe(false);
  });

  it("B: trades truncated, activity complete — evaluate trades boundary only", () => {
    const events = [event(tradesBoundary - 100)];
    const boundaries = computeSourceBoundaryStats(
      events,
      activityBoundary,
      tradesBoundary
    );
    const flags = resolveSourceSpecificTruncationFlags({
      apiActivityTruncated: false,
      apiTradesTruncated: true,
      oldestActivityTimestamp: activityBoundary,
      oldestTradesTimestamp: tradesBoundary,
      runSourceBoundaries: boundaries,
    });
    expect(flags.activityTruncated).toBe(false);
    expect(flags.tradesTruncationImmune).toBe(true);
    expect(flags.tradesTruncated).toBe(false);
  });

  it("C: both truncated — both boundaries must be satisfied independently", () => {
    const events = [event(indexedMay2024)];
    const boundaries = computeSourceBoundaryStats(
      events,
      activityBoundary,
      tradesBoundary
    );
    expect(boundaries.eventsBeforeActivityBoundary).toBeGreaterThan(0);
    expect(boundaries.eventsBeforeTradesBoundary).toBe(0);
    const flags = resolveSourceSpecificTruncationFlags({
      apiActivityTruncated: true,
      apiTradesTruncated: true,
      oldestActivityTimestamp: activityBoundary,
      oldestTradesTimestamp: tradesBoundary,
      runSourceBoundaries: boundaries,
    });
    expect(flags.activityTruncated).toBe(false);
    expect(flags.activityTruncationImmune).toBe(true);
    expect(flags.tradesTruncated).toBe(true);
    expect(flags.tradesTruncationImmune).toBe(false);
  });

  it("D: neither truncated — truncation does not block credibility", () => {
    const boundaries = computeSourceBoundaryStats(
      [event(indexedMay2024)],
      activityBoundary,
      tradesBoundary
    );
    const flags = resolveSourceSpecificTruncationFlags({
      apiActivityTruncated: false,
      apiTradesTruncated: false,
      oldestActivityTimestamp: activityBoundary,
      oldestTradesTimestamp: tradesBoundary,
      runSourceBoundaries: boundaries,
    });
    expect(flags.activityTruncated).toBe(false);
    expect(flags.tradesTruncated).toBe(false);
  });

  it("trades oldest must not be used as the activity truncation boundary", () => {
    const events = [event(indexedMay2024)];
    const boundaries = computeSourceBoundaryStats(
      events,
      activityBoundary,
      tradesBoundary
    );
    expect(boundaries.eventsBeforeTradesBoundary).toBe(0);
    expect(boundaries.eventsBeforeActivityBoundary).toBeGreaterThan(0);
    const flags = resolveSourceSpecificTruncationFlags({
      apiActivityTruncated: true,
      apiTradesTruncated: false,
      oldestActivityTimestamp: activityBoundary,
      oldestTradesTimestamp: tradesBoundary,
      runSourceBoundaries: boundaries,
    });
    expect(flags.activityTruncationImmune).toBe(true);
    expect(flags.activityTruncated).toBe(false);
  });
});

describe("adaptive from block", () => {
  it("uses pilot proven block for d27cc742 when no verified evidence exists", () => {
    const result = resolveAdaptiveFromBlock({
      wallet: "0xd27cc742d023d06ef633a4c880cf1ff1836ec081",
      incrementalFromBlock: POLYMARKET_EXCHANGE_INITIAL_BLOCK,
      fullHistory: true,
      verifiedOldestTradeBlock: null,
      allowEarlierThanIncremental: true,
    });
    expect(result.usedPilotOverride).toBe(true);
    expect(result.fromBlock).toBeLessThan(POLYMARKET_EXCHANGE_INITIAL_BLOCK);
    expect(result.fromBlock).toBe(48_565_033 - 10_000);
    expect(result.contributingSource).toBe("pilot_proven");
  });

  it("prefers earliest verified trade block over pilot proven block", () => {
    const verifiedTradeBlock = 47_546_811;
    const result = resolveAdaptiveFromBlock({
      wallet: "0xd27cc742d023d06ef633a4c880cf1ff1836ec081",
      incrementalFromBlock: POLYMARKET_EXCHANGE_INITIAL_BLOCK,
      fullHistory: true,
      verifiedOldestTradeBlock: verifiedTradeBlock,
      allowEarlierThanIncremental: true,
    });
    expect(result.fromBlock).toBe(verifiedTradeBlock - 10_000);
    expect(result.fromBlock).toBeLessThan(47_546_811);
    expect(result.contributingSource).toBe("verified_trade");
    expect(result.earliestRelevantBlock).toBe(verifiedTradeBlock);
  });

  it("does not move earlier on incremental checkpoint by default", () => {
    const result = resolveAdaptiveFromBlock({
      wallet: "0xd27cc742d023d06ef633a4c880cf1ff1836ec081",
      incrementalFromBlock: 93_693_000,
      fullHistory: true,
      verifiedOldestTradeBlock: 48_565_033,
    });
    expect(result.fromBlock).toBe(93_693_000);
    expect(result.reason).toBe("incremental_checkpoint");
  });
});
