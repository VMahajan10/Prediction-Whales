import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { walletHistoricalMetrics } from "@/lib/crossmarket/store/schema";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  MIN_PRODUCT_FEED_RESOLVED_VOLUME_USD,
  type ProductFeedHistoricalVolumeGateReason,
} from "@/lib/feedQualification";

export type ProductFeedHistoricalVolumeResolution =
  | {
      status: "trusted";
      resolvedVolumeUSD: number;
      historicalVolumeGateReason: null;
      historicalResolvedVolumeTrusted: true;
    }
  | {
      status: "unavailable";
      resolvedVolumeUSD: null;
      historicalVolumeGateReason: "historical_volume_unavailable";
      historicalResolvedVolumeTrusted: false;
    }
  | {
      status: "below_threshold";
      resolvedVolumeUSD: number;
      historicalVolumeGateReason: "historical_volume_below_minimum";
      historicalResolvedVolumeTrusted: false;
    };

const UNAVAILABLE: ProductFeedHistoricalVolumeResolution = {
  status: "unavailable",
  resolvedVolumeUSD: null,
  historicalVolumeGateReason: "historical_volume_unavailable",
  historicalResolvedVolumeTrusted: false,
};

/**
 * Indexed `resolved_volume_usd` must be a finite number. Rejects null, NaN,
 * ±Infinity, and non-numeric strings (e.g. `"abc"`).
 */
export function coerceFiniteResolvedVolumeUsd(value: unknown): number | null {
  if (value == null) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

type IndexedVolumeRow = {
  walletAddress: string;
  credibilityMetricsValid: boolean;
  resolvedVolumeUsd: unknown;
};

/** One wallet's rows at a fixed metric_version (unique index should enforce ≤1). */
export function resolveHistoricalVolumeForWalletMetricRows(
  rows: IndexedVolumeRow[]
): ProductFeedHistoricalVolumeResolution {
  if (rows.length === 0) {
    return UNAVAILABLE;
  }
  if (rows.length > 1) {
    return UNAVAILABLE;
  }
  return resolveProductFeedHistoricalVolumeFromIndexedRow(rows[0]);
}

export function resolveProductFeedHistoricalVolumeFromIndexedRow(
  row:
    | {
        credibilityMetricsValid: boolean;
        resolvedVolumeUsd: unknown;
      }
    | null
    | undefined
): ProductFeedHistoricalVolumeResolution {
  if (!row?.credibilityMetricsValid) {
    return UNAVAILABLE;
  }

  const volumeUsd = coerceFiniteResolvedVolumeUsd(row.resolvedVolumeUsd);
  if (volumeUsd == null) {
    return UNAVAILABLE;
  }

  if (volumeUsd < MIN_PRODUCT_FEED_RESOLVED_VOLUME_USD) {
    return {
      status: "below_threshold",
      resolvedVolumeUSD: volumeUsd,
      historicalVolumeGateReason: "historical_volume_below_minimum",
      historicalResolvedVolumeTrusted: false,
    };
  }

  return {
    status: "trusted",
    resolvedVolumeUSD: volumeUsd,
    historicalVolumeGateReason: null,
    historicalResolvedVolumeTrusted: true,
  };
}

/**
 * One batched read for all candidate wallets — avoids per-trade N+1 on feed qualification.
 *
 * Duplicate rows for the same `(wallet_address, metric_version)` should be impossible
 * (`wallet_historical_metrics_wallet_version_unique`). If multiple rows are returned
 * for one wallet, fail closed as unavailable rather than picking arbitrarily.
 */
export async function fetchProductFeedHistoricalVolumeByWallet(
  walletAddresses: string[]
): Promise<Map<string, ProductFeedHistoricalVolumeResolution>> {
  const normalized = Array.from(
    new Set(
      walletAddresses
        .map((wallet) => wallet.trim().toLowerCase())
        .filter((wallet) => wallet.length > 0)
    )
  );

  const out = new Map<string, ProductFeedHistoricalVolumeResolution>();
  for (const wallet of normalized) {
    out.set(wallet, UNAVAILABLE);
  }

  if (normalized.length === 0 || !isDatabaseEnabled()) {
    return out;
  }

  const db = getDb();
  const rows = await db
    .select({
      walletAddress: walletHistoricalMetrics.walletAddress,
      credibilityMetricsValid: walletHistoricalMetrics.credibilityMetricsValid,
      resolvedVolumeUsd: walletHistoricalMetrics.resolvedVolumeUsd,
    })
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION),
        sql`lower(${walletHistoricalMetrics.walletAddress}) IN (${sql.join(
          normalized.map((wallet) => sql`${wallet}`),
          sql`, `
        )})`
      )
    );

  const rowsByWallet = new Map<
    string,
    Array<{
      walletAddress: string;
      credibilityMetricsValid: boolean;
      resolvedVolumeUsd: unknown;
    }>
  >();

  for (const row of rows) {
    const key = row.walletAddress.trim().toLowerCase();
    const group = rowsByWallet.get(key);
    if (group) {
      group.push(row);
    } else {
      rowsByWallet.set(key, [row]);
    }
  }

  for (const [key, group] of rowsByWallet) {
    out.set(key, resolveHistoricalVolumeForWalletMetricRows(group));
  }

  return out;
}

export function historicalVolumeObservabilityFields(
  resolution: ProductFeedHistoricalVolumeResolution
): {
  historicalVolumeUsd: number | null;
  historicalVolumeTrusted: boolean;
  historicalVolumeReason: ProductFeedHistoricalVolumeGateReason | null;
} {
  return {
    historicalVolumeUsd: resolution.resolvedVolumeUSD,
    historicalVolumeTrusted: resolution.historicalResolvedVolumeTrusted,
    historicalVolumeReason: resolution.historicalVolumeGateReason,
  };
}
