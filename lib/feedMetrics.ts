/**
 * Daily feed qualification metrics (server/API routes only).
 * Tracks detected vs gate-passed trades and distinct qualified whales.
 */

export interface FeedMetricsRecordInput {
  tradesDetected?: number;
  gatePassedTrades?: number;
  whaleWallets?: (string | null | undefined)[];
}

type FeedMetricsDay = {
  dayKey: string;
  tradesDetected: number;
  gatePassedTrades: number;
  distinctWhales: Set<string>;
};

const STORE_KEY = "__marketpulseFeedMetrics";
const SNAPSHOT_INTERVAL_MS = 60_000;

let lastSnapshotMs = 0;

function currentDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getStore(): FeedMetricsDay {
  const globalStore = globalThis as typeof globalThis & {
    [STORE_KEY]?: FeedMetricsDay;
  };
  const dayKey = currentDayKey();

  if (!globalStore[STORE_KEY] || globalStore[STORE_KEY]!.dayKey !== dayKey) {
    if (globalStore[STORE_KEY]) {
      logFeedMetricsSummary(globalStore[STORE_KEY]!);
    }
    globalStore[STORE_KEY] = {
      dayKey,
      tradesDetected: 0,
      gatePassedTrades: 0,
      distinctWhales: new Set(),
    };
  }

  return globalStore[STORE_KEY]!;
}

export function logFeedMetricsSummary(store: FeedMetricsDay): void {
  console.log(
    `[FeedMetrics] date=${store.dayKey} tradesDetected=${store.tradesDetected} gatePassedTrades=${store.gatePassedTrades} distinctWhales=${store.distinctWhales.size}`
  );
}

export function recordFeedMetrics(input: FeedMetricsRecordInput): void {
  const store = getStore();
  store.tradesDetected += input.tradesDetected ?? 0;
  store.gatePassedTrades += input.gatePassedTrades ?? 0;

  for (const wallet of input.whaleWallets ?? []) {
    const normalized = wallet?.trim().toLowerCase();
    if (normalized) store.distinctWhales.add(normalized);
  }

  const now = Date.now();
  if (now - lastSnapshotMs >= SNAPSHOT_INTERVAL_MS) {
    lastSnapshotMs = now;
    logFeedMetricsSummary(store);
  }
}

export function resetFeedMetricsForTests(): void {
  const globalStore = globalThis as typeof globalThis & {
    [STORE_KEY]?: FeedMetricsDay;
  };
  delete globalStore[STORE_KEY];
  lastSnapshotMs = 0;
}
