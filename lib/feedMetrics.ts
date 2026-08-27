/**
 * Daily feed qualification metrics.
 * Tracks detected vs gate-passed trades and distinct qualified whales.
 *
 * In-memory counters remain for debugging snapshots; durable aggregates are
 * persisted to Postgres via feedMetricsPersistence (UTC day keys).
 */

import { logger } from "@/lib/logger";
import type { FeedMetricsVenue } from "@/lib/crossmarket/store/schema";
import {
  feedMetricsDayKeyUtc,
  normalizeFeedMetricVenue,
  normalizeFeedMetricWallets,
} from "@/lib/feedMetricsCore";

export type { FeedMetricsVenue } from "@/lib/crossmarket/store/schema";
export { feedMetricsDayKeyUtc } from "@/lib/feedMetricsCore";

export interface FeedMetricsRecordInput {
  venue?: FeedMetricsVenue;
  tradesDetected?: number;
  gatePassedTrades?: number;
  whaleWallets?: (string | null | undefined)[];
}

type FeedMetricsDay = {
  dayKey: string;
  venue: FeedMetricsVenue;
  tradesDetected: number;
  gatePassedTrades: number;
  distinctWhales: Set<string>;
};

const STORE_KEY = "__marketpulseFeedMetrics";
const SNAPSHOT_INTERVAL_MS = 60_000;

function isBrowserRuntime(): boolean {
  return typeof globalThis !== "undefined" && "window" in globalThis;
}

let lastSnapshotMs = 0;

function currentDayKey(): string {
  return feedMetricsDayKeyUtc();
}

function storeKey(dayKey: string, venue: FeedMetricsVenue): string {
  return `${dayKey}|${venue}`;
}

function getStore(venue: FeedMetricsVenue): FeedMetricsDay {
  const globalStore = globalThis as typeof globalThis & {
    [STORE_KEY]?: Map<string, FeedMetricsDay>;
  };
  const dayKey = currentDayKey();
  const key = storeKey(dayKey, venue);

  if (!globalStore[STORE_KEY]) {
    globalStore[STORE_KEY] = new Map();
  }

  const map = globalStore[STORE_KEY]!;
  const existing = map.get(key);
  if (existing) return existing;

  const created: FeedMetricsDay = {
    dayKey,
    venue,
    tradesDetected: 0,
    gatePassedTrades: 0,
    distinctWhales: new Set(),
  };
  map.set(key, created);
  return created;
}

export function logFeedMetricsSummary(store: FeedMetricsDay): void {
  logger.debug(
    `[FeedMetrics] date=${store.dayKey} venue=${store.venue} tradesDetected=${store.tradesDetected} gatePassedTrades=${store.gatePassedTrades} distinctWhales=${store.distinctWhales.size}`
  );
}

function applyInMemoryMetrics(input: FeedMetricsRecordInput): FeedMetricsDay {
  const venue = normalizeFeedMetricVenue(input.venue);
  const store = getStore(venue);
  store.tradesDetected += input.tradesDetected ?? 0;
  store.gatePassedTrades += input.gatePassedTrades ?? 0;

  for (const wallet of normalizeFeedMetricWallets(input.whaleWallets)) {
    store.distinctWhales.add(wallet);
  }

  return store;
}

function scheduleFeedMetricsPersistence(input: FeedMetricsRecordInput): void {
  if (isBrowserRuntime()) return;

  void import("@/lib/feedMetricsPersistence")
    .then(({ persistFeedMetricsIncrement }) => persistFeedMetricsIncrement(input))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[FeedMetrics] persistence failed (non-fatal): ${message}`);
    });
}

export function recordFeedMetrics(input: FeedMetricsRecordInput): void {
  const store = applyInMemoryMetrics(input);

  const now = Date.now();
  if (now - lastSnapshotMs >= SNAPSHOT_INTERVAL_MS) {
    lastSnapshotMs = now;
    logFeedMetricsSummary(store);
  }

  scheduleFeedMetricsPersistence(input);
}

/** Await durable persistence — used by API routes that need write confirmation. */
export async function recordFeedMetricsAndPersist(
  input: FeedMetricsRecordInput
): Promise<void> {
  applyInMemoryMetrics(input);
  if (isBrowserRuntime()) return;

  const { persistFeedMetricsIncrement } = await import(
    "@/lib/feedMetricsPersistence"
  );
  await persistFeedMetricsIncrement(input);
}

export function resetFeedMetricsForTests(): void {
  const globalStore = globalThis as typeof globalThis & {
    [STORE_KEY]?: Map<string, FeedMetricsDay>;
  };
  delete globalStore[STORE_KEY];
  lastSnapshotMs = 0;
}
