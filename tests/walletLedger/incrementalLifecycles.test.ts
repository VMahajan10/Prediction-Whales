import { describe, expect, it } from "vitest";
import {
  affectedPositionKeysFromEvents,
  buildEventsByCondition,
  lifecycleBaseKeyString,
  lifecycleKeyString,
  persistedLifecycleRowsEqual,
  planIncrementalLifecycleWrites,
  positionToPersistedRow,
  resolutionAffectedPositionKeys,
} from "@/lib/walletLedger/indexed/store/incrementalLifecycles";
import type { PositionLifecycle, WalletLedgerEvent } from "@/lib/walletLedger/types";

const WALLET = "0xwallet";

function event(
  overrides: Partial<WalletLedgerEvent> & Pick<WalletLedgerEvent, "type">
): WalletLedgerEvent {
  return {
    wallet: WALLET,
    conditionId: "cond-a",
    asset: "asset-yes",
    timestamp: 1_000,
    dedupeKey: `key-${Math.random()}`,
    source: "activity",
    ...overrides,
  };
}

function position(
  overrides: Partial<PositionLifecycle> = {}
): PositionLifecycle {
  return {
    wallet: WALLET,
    conditionId: "cond-a",
    asset: "asset-yes",
    lifecycleEpisode: 0,
    title: "Market",
    outcome: "Yes",
    slug: null,
    events: [],
    grossBuyCash: 100,
    grossSellCash: 0,
    redeemCash: 0,
    netShares: 10,
    maxCumulativeCashOutlay: 100,
    firstEntryAt: 1,
    lastActivityAt: 2,
    fullyExited: false,
    accountingStatus: "open",
    completed: false,
    completionReason: null,
    resolution: null,
    resolutionPayoutUsd: 0,
    realizedPnl: null,
    capitalAtRisk: 100,
    positionRoi: null,
    heldThroughResolution: false,
    outcomeCorrect: null,
    excludedFromMetrics: false,
    exclusionReason: null,
    ...overrides,
  };
}

function persistedFromPosition(p: PositionLifecycle) {
  return positionToPersistedRow(p);
}

describe("incremental lifecycle persistence planning", () => {
  it("A: no new events — affected=0, no lifecycle rewrite", () => {
    const existing = position({ netShares: 10, completed: false });
    const plan = planIncrementalLifecycleWrites({
      allPositions: [existing],
      novelEvents: [],
      allEvents: [event({ type: "BUY", shares: 10, cashUsd: 100 })],
      persistedRows: [persistedFromPosition(existing)],
    });
    expect(plan.lifecycleMode).toBe("incremental");
    expect(plan.affectedKeys.size).toBe(0);
    expect(plan.writes).toHaveLength(0);
  });

  it("B: one BUY for one position — only that lifecycle recomputed", () => {
    const buy = event({ type: "BUY", shares: 5, cashUsd: 50, dedupeKey: "buy-1" });
    const existing = position({
      grossBuyCash: 100,
      netShares: 10,
      capitalAtRisk: 100,
    });
    const updated = position({
      grossBuyCash: 150,
      netShares: 15,
      capitalAtRisk: 150,
    });
    const plan = planIncrementalLifecycleWrites({
      allPositions: [updated],
      novelEvents: [buy],
      allEvents: [
        event({ type: "BUY", shares: 10, cashUsd: 100, dedupeKey: "buy-0" }),
        buy,
      ],
      persistedRows: [persistedFromPosition(existing)],
    });
    expect(plan.affectedKeys).toEqual(
      new Set([lifecycleBaseKeyString({ conditionId: "cond-a", assetId: "asset-yes" })])
    );
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.action).toBe("update");
  });

  it("C: SELL completing position — only affected lifecycle updated", () => {
    const sell = event({
      type: "SELL",
      shares: 10,
      cashUsd: 120,
      dedupeKey: "sell-1",
    });
    const existing = position({
      grossBuyCash: 100,
      grossSellCash: 0,
      netShares: 10,
      completed: false,
      fullyExited: false,
    });
    const completed = position({
      grossBuyCash: 100,
      grossSellCash: 120,
      netShares: 0,
      completed: true,
      fullyExited: true,
      completionReason: "fully_exited",
      realizedPnl: 20,
      positionRoi: 0.2,
    });
    const other = position({
      conditionId: "cond-b",
      asset: "asset-b",
      grossBuyCash: 50,
      netShares: 5,
    });
    const plan = planIncrementalLifecycleWrites({
      allPositions: [completed, other],
      novelEvents: [sell],
      allEvents: [
        event({ type: "BUY", conditionId: "cond-b", asset: "asset-b", dedupeKey: "b0" }),
        event({ type: "BUY", dedupeKey: "a0" }),
        sell,
      ],
      persistedRows: [
        persistedFromPosition(existing),
        persistedFromPosition(other),
      ],
    });
    expect(plan.affectedKeys.size).toBe(1);
    expect(plan.writes[0]?.action).toBe("update");
  });

  it("D: resolution change — affected lifecycle updated with no wallet trade delta", () => {
    const open = position({
      netShares: 10,
      completed: false,
      resolution: { resolutionFinal: false, source: "gamma" },
    });
    const resolved = position({
      netShares: 10,
      completed: true,
      heldThroughResolution: true,
      completionReason: "held_through_resolution",
      resolution: { resolutionFinal: true, source: "gamma" },
      resolutionPayoutUsd: 10,
      realizedPnl: 10,
      positionRoi: 0.1,
      outcomeCorrect: true,
    });
    const plan = planIncrementalLifecycleWrites({
      allPositions: [resolved],
      novelEvents: [],
      allEvents: [event({ type: "BUY", shares: 10, cashUsd: 100, dedupeKey: "buy" })],
      persistedRows: [persistedFromPosition(open)],
    });
    expect(plan.affectedKeys.size).toBe(1);
    expect(plan.writes[0]?.action).toBe("update");
  });

  it("E: MERGE/SPLIT — all assets on condition recomputed", () => {
    const eventsByCondition = buildEventsByCondition([
      event({ type: "BUY", conditionId: "cond-m", asset: "asset-yes", dedupeKey: "y" }),
      event({ type: "BUY", conditionId: "cond-m", asset: "asset-no", dedupeKey: "n" }),
    ]);
    const merge = event({
      type: "MERGE",
      conditionId: "cond-m",
      asset: "",
      dedupeKey: "merge-1",
    });
    const affected = affectedPositionKeysFromEvents([merge], eventsByCondition);
    expect(affected).toEqual(
      new Set([
        lifecycleBaseKeyString({ conditionId: "cond-m", assetId: "asset-yes" }),
        lifecycleBaseKeyString({ conditionId: "cond-m", assetId: "asset-no" }),
      ])
    );
  });

  it("F: rerun same event — zero lifecycle changes", () => {
    const buy = event({ type: "BUY", shares: 10, cashUsd: 100, dedupeKey: "buy" });
    const pos = position({ grossBuyCash: 100, netShares: 10 });
    const row = persistedFromPosition(pos);
    const plan = planIncrementalLifecycleWrites({
      allPositions: [pos],
      novelEvents: [buy],
      allEvents: [buy],
      persistedRows: [row],
    });
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.action).toBe("unchanged");
  });

  it("G: metric version change — full rebuild when no persisted rows for version", () => {
    const positions = [
      position({ conditionId: "c1", asset: "a1" }),
      position({ conditionId: "c2", asset: "a2" }),
    ];
    const plan = planIncrementalLifecycleWrites({
      allPositions: positions,
      novelEvents: [],
      allEvents: [],
      persistedRows: [],
    });
    expect(plan.lifecycleMode).toBe("full");
    expect(plan.affectedKeys.size).toBe(2);
    expect(plan.writes.every((w) => w.action === "insert")).toBe(true);
  });

  it("H: 20k persisted positions + 1 affected — writes only 1 lifecycle", () => {
    const persistedRows = Array.from({ length: 20_000 }, (_, i) =>
      persistedFromPosition(
        position({
          conditionId: `cond-${i}`,
          asset: `asset-${i}`,
          grossBuyCash: 10,
          netShares: 1,
        })
      )
    );
    const buy = event({
      type: "BUY",
      conditionId: "cond-0",
      asset: "asset-0",
      dedupeKey: "new-buy",
    });
    const updated = position({
      conditionId: "cond-0",
      asset: "asset-0",
      grossBuyCash: 20,
      netShares: 2,
    });
    const plan = planIncrementalLifecycleWrites({
      allPositions: [
        updated,
        ...Array.from({ length: 19_999 }, (_, i) =>
          position({
            conditionId: `cond-${i + 1}`,
            asset: `asset-${i + 1}`,
            grossBuyCash: 10,
            netShares: 1,
          })
        ),
      ],
      novelEvents: [buy],
      allEvents: [buy],
      persistedRows,
    });
    expect(plan.affectedKeys.size).toBe(1);
    expect(plan.writes.filter((w) => w.action !== "unchanged")).toHaveLength(1);
    expect(plan.writes[0]?.action).toBe("update");
  });

  it("I: resumes interrupted full rebuild when partial lifecycles already durable", () => {
    const positions = Array.from({ length: 50 }, (_, i) =>
      position({
        conditionId: `cond-${i}`,
        asset: `asset-${i}`,
      })
    );
    const persistedRows = positions.slice(0, 20).map(persistedFromPosition);
    const plan = planIncrementalLifecycleWrites({
      allPositions: positions,
      novelEvents: [],
      allEvents: [],
      persistedRows,
    });
    expect(plan.lifecycleMode).toBe("incremental");
    expect(plan.writes.filter((w) => w.action === "insert")).toHaveLength(30);
  });

  it("resolutionAffectedPositionKeys isolates resolution-only deltas", () => {
    const open = position({
      resolution: { resolutionFinal: false, source: "gamma" },
    });
    const resolved = position({
      completed: true,
      resolution: { resolutionFinal: true, source: "gamma" },
      resolutionPayoutUsd: 5,
      realizedPnl: 5,
    });
    const keys = resolutionAffectedPositionKeys(
      [resolved],
      [persistedFromPosition(open)],
      new Set()
    );
    expect(keys.size).toBe(1);
    expect(
      persistedLifecycleRowsEqual(
        positionToPersistedRow(resolved),
        positionToPersistedRow(resolved)
      )
    ).toBe(true);
  });
});
