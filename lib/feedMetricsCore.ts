import type { FeedMetricsVenue } from "@/lib/crossmarket/store/schema";

/** Daily feed metrics roll up on UTC calendar days (YYYY-MM-DD). */
export function feedMetricsDayKeyUtc(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function normalizeFeedMetricVenue(
  venue: FeedMetricsVenue | undefined
): FeedMetricsVenue {
  return venue ?? "polymarket";
}

export function normalizeFeedMetricWallets(
  wallets: ReadonlyArray<string | null | undefined> | undefined
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const wallet of wallets ?? []) {
    const value = wallet?.trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

export interface FeedMetricsPersistInput {
  venue?: FeedMetricsVenue;
  dayKey?: string;
  tradesDetected?: number;
  gatePassedTrades?: number;
  whaleWallets?: ReadonlyArray<string | null | undefined>;
}

export interface FeedDailyMetricsSnapshot {
  dayKey: string;
  venue: FeedMetricsVenue;
  tradesDetected: number;
  gatePassedTrades: number;
  distinctWhales: number;
  createdAt: Date;
  updatedAt: Date;
}

function counterKey(dayKey: string, venue: FeedMetricsVenue): string {
  return `${dayKey}|${venue}`;
}

function whaleKey(
  dayKey: string,
  venue: FeedMetricsVenue,
  wallet: string
): string {
  return `${dayKey}|${venue}|${wallet}`;
}

/**
 * In-memory store mirroring DB increment + unique-whale semantics for tests
 * and local fallback when DATABASE_URL is unset.
 */
export class InMemoryFeedMetricsStore {
  private counters = new Map<
    string,
    {
      tradesDetected: number;
      gatePassedTrades: number;
      createdAt: Date;
      updatedAt: Date;
    }
  >();
  private whales = new Set<string>();

  apply(input: FeedMetricsPersistInput, now = new Date()): void {
    const venue = normalizeFeedMetricVenue(input.venue);
    const dayKey = input.dayKey ?? feedMetricsDayKeyUtc(now);
    const tradesDetected = Math.max(0, input.tradesDetected ?? 0);
    const gatePassedTrades = Math.max(0, input.gatePassedTrades ?? 0);
    const wallets = normalizeFeedMetricWallets(input.whaleWallets);
    const key = counterKey(dayKey, venue);

    const existing = this.counters.get(key);
    if (existing) {
      existing.tradesDetected += tradesDetected;
      existing.gatePassedTrades += gatePassedTrades;
      existing.updatedAt = now;
    } else {
      this.counters.set(key, {
        tradesDetected,
        gatePassedTrades,
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const wallet of wallets) {
      this.whales.add(whaleKey(dayKey, venue, wallet));
    }
  }

  get(dayKey: string, venue: FeedMetricsVenue): FeedDailyMetricsSnapshot | null {
    const row = this.counters.get(counterKey(dayKey, venue));
    if (!row) return null;

    return {
      dayKey,
      venue,
      tradesDetected: row.tradesDetected,
      gatePassedTrades: row.gatePassedTrades,
      distinctWhales: this.countDistinctWhales(dayKey, venue),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  list(options: {
    dayKey?: string;
    venue?: FeedMetricsVenue;
    fromDayKey?: string;
    toDayKey?: string;
  } = {}): FeedDailyMetricsSnapshot[] {
    const rows: FeedDailyMetricsSnapshot[] = [];

    for (const [key, row] of this.counters.entries()) {
      const [dayKey, venueRaw] = key.split("|");
      const venue = venueRaw as FeedMetricsVenue;
      if (options.dayKey && dayKey !== options.dayKey) continue;
      if (options.venue && venue !== options.venue) continue;
      if (options.fromDayKey && dayKey < options.fromDayKey) continue;
      if (options.toDayKey && dayKey > options.toDayKey) continue;

      rows.push({
        dayKey,
        venue,
        tradesDetected: row.tradesDetected,
        gatePassedTrades: row.gatePassedTrades,
        distinctWhales: this.countDistinctWhales(dayKey, venue),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }

    return rows.sort((a, b) => b.dayKey.localeCompare(a.dayKey));
  }

  reset(): void {
    this.counters.clear();
    this.whales.clear();
  }

  private countDistinctWhales(dayKey: string, venue: FeedMetricsVenue): number {
    let count = 0;
    const prefix = `${dayKey}|${venue}|`;
    for (const key of this.whales) {
      if (key.startsWith(prefix)) count += 1;
    }
    return count;
  }
}
