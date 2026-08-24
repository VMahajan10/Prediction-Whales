import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  feedMetricsDayKeyUtc,
  InMemoryFeedMetricsStore,
  normalizeFeedMetricWallets,
} from "@/lib/feedMetricsCore";

const WALLET_A = "0xabc123def4567890abcdef1234567890abcdef12";
const WALLET_B = "0xdef4567890abcdef1234567890abcdef12345678";
const DAY_ONE = "2026-08-24";
const DAY_TWO = "2026-08-25";

describe("feedMetricsCore", () => {
  it("uses UTC day keys", () => {
    expect(
      feedMetricsDayKeyUtc(new Date("2026-08-24T23:30:00.000Z"))
    ).toBe("2026-08-24");
    expect(
      feedMetricsDayKeyUtc(new Date("2026-08-25T00:30:00.000Z"))
    ).toBe("2026-08-25");
  });

  it("normalizes wallet addresses before deduplication", () => {
    expect(
      normalizeFeedMetricWallets([
        "0xABC",
        "0xabc",
        " 0xDef ",
        null,
        "",
      ])
    ).toEqual(["0xabc", "0xdef"]);
  });
});

describe("InMemoryFeedMetricsStore", () => {
  it("persists basic daily counters and distinct whales", () => {
    const store = new InMemoryFeedMetricsStore();
    const now = new Date(`${DAY_ONE}T12:00:00.000Z`);

    store.apply(
      {
        venue: "polymarket",
        dayKey: DAY_ONE,
        tradesDetected: 3,
        gatePassedTrades: 2,
        whaleWallets: [WALLET_A, WALLET_B],
      },
      now
    );

    const row = store.get(DAY_ONE, "polymarket");
    expect(row).toMatchObject({
      tradesDetected: 3,
      gatePassedTrades: 2,
      distinctWhales: 2,
    });
  });

  it("counts three gate-passed trades for one wallet as one distinct whale", () => {
    const store = new InMemoryFeedMetricsStore();

    store.apply({
      venue: "polymarket",
      dayKey: DAY_ONE,
      gatePassedTrades: 1,
      whaleWallets: [WALLET_A],
    });
    store.apply({
      venue: "polymarket",
      dayKey: DAY_ONE,
      gatePassedTrades: 1,
      whaleWallets: [WALLET_A],
    });
    store.apply({
      venue: "polymarket",
      dayKey: DAY_ONE,
      gatePassedTrades: 1,
      whaleWallets: [WALLET_A.toUpperCase()],
    });

    const row = store.get(DAY_ONE, "polymarket");
    expect(row?.gatePassedTrades).toBe(3);
    expect(row?.distinctWhales).toBe(1);
  });

  it("keeps distinct whale count at one across multiple batches for the same wallet", () => {
    const store = new InMemoryFeedMetricsStore();

    store.apply({
      venue: "polymarket",
      dayKey: DAY_ONE,
      gatePassedTrades: 1,
      whaleWallets: [WALLET_A],
    });
    store.apply({
      venue: "polymarket",
      dayKey: DAY_ONE,
      gatePassedTrades: 1,
      whaleWallets: [WALLET_A],
    });

    expect(store.get(DAY_ONE, "polymarket")?.distinctWhales).toBe(1);
  });

  it("tracks two distinct qualified wallets", () => {
    const store = new InMemoryFeedMetricsStore();

    store.apply({
      venue: "polymarket",
      dayKey: DAY_ONE,
      gatePassedTrades: 2,
      whaleWallets: [WALLET_A, WALLET_B],
    });

    expect(store.get(DAY_ONE, "polymarket")?.distinctWhales).toBe(2);
  });

  it("does not add rejected wallets when only tradesDetected increments", () => {
    const store = new InMemoryFeedMetricsStore();

    store.apply({
      venue: "polymarket",
      dayKey: DAY_ONE,
      tradesDetected: 1,
      gatePassedTrades: 0,
      whaleWallets: [],
    });

    const row = store.get(DAY_ONE, "polymarket");
    expect(row?.tradesDetected).toBe(1);
    expect(row?.gatePassedTrades).toBe(0);
    expect(row?.distinctWhales).toBe(0);
  });

  it("keeps daily aggregates independent across UTC day rollover", () => {
    const store = new InMemoryFeedMetricsStore();

    store.apply({
      venue: "polymarket",
      dayKey: DAY_ONE,
      tradesDetected: 4,
      gatePassedTrades: 2,
      whaleWallets: [WALLET_A],
    });
    store.apply({
      venue: "polymarket",
      dayKey: DAY_TWO,
      tradesDetected: 1,
      gatePassedTrades: 1,
      whaleWallets: [WALLET_B],
    });

    expect(store.get(DAY_ONE, "polymarket")).toMatchObject({
      tradesDetected: 4,
      gatePassedTrades: 2,
      distinctWhales: 1,
    });
    expect(store.get(DAY_TWO, "polymarket")).toMatchObject({
      tradesDetected: 1,
      gatePassedTrades: 1,
      distinctWhales: 1,
    });
  });

  it("separates venues so Kalshi metrics do not mix with Polymarket", () => {
    const store = new InMemoryFeedMetricsStore();

    store.apply({
      venue: "polymarket",
      dayKey: DAY_ONE,
      tradesDetected: 2,
      gatePassedTrades: 1,
      whaleWallets: [WALLET_A],
    });
    store.apply({
      venue: "kalshi",
      dayKey: DAY_ONE,
      tradesDetected: 5,
      gatePassedTrades: 0,
    });

    expect(store.get(DAY_ONE, "polymarket")).toMatchObject({
      tradesDetected: 2,
      gatePassedTrades: 1,
      distinctWhales: 1,
    });
    expect(store.get(DAY_ONE, "kalshi")).toMatchObject({
      tradesDetected: 5,
      gatePassedTrades: 0,
      distinctWhales: 0,
    });
  });

  it("accumulates concurrent-style increments without losing counts", async () => {
    const store = new InMemoryFeedMetricsStore();
    const input = {
      venue: "polymarket" as const,
      dayKey: DAY_ONE,
      tradesDetected: 1,
      gatePassedTrades: 1,
      whaleWallets: [WALLET_A],
    };

    await Promise.all(
      Array.from({ length: 5 }, () =>
        Promise.resolve().then(() => store.apply(input))
      )
    );

    const row = store.get(DAY_ONE, "polymarket");
    expect(row?.tradesDetected).toBe(5);
    expect(row?.gatePassedTrades).toBe(5);
    expect(row?.distinctWhales).toBe(1);
  });
});

describe("feedMetricsPersistence SQL contract", () => {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn();
  const update = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    onConflictDoUpdate.mockClear();
    onConflictDoNothing.mockClear();
    insert.mockClear();
    update.mockClear();

    insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate,
        onConflictDoNothing,
      }),
    });
    update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
  });

  it("uses atomic upsert/increment semantics via mocked db calls", async () => {
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/lib/crossmarket/store/db", () => ({
      isDatabaseEnabled: () => true,
      getDb: () => ({ insert, update, select: vi.fn() }),
    }));

    const { persistFeedMetricsIncrement } = await import(
      "@/lib/feedMetricsPersistence"
    );

    await persistFeedMetricsIncrement({
      venue: "polymarket",
      dayKey: DAY_ONE,
      tradesDetected: 3,
      gatePassedTrades: 2,
      whaleWallets: [WALLET_A, WALLET_B, WALLET_A],
    });

    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
