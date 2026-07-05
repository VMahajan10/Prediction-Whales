/**
 * Ephemeral arbitrage window cache — separate `arb:` namespace.
 * Does not write to EV pipeline Redis keys.
 */

import { Redis } from "@upstash/redis";
import type { ArbitrageWindow } from "@/lib/arbitrageFinder/types";
import type { ArbitrageScanCoverageReport } from "@/lib/arbitrageFinder/observability/pairDiagnostics";
import { isEvRedisEnabled } from "@/lib/evPipeline/redisCache";

export const ARB_WINDOW_CACHE_TTL_SEC = 45;
export const ARB_SCAN_META_TTL_SEC = 300;

export const arbRedisKeys = {
  window: (pairKey: string) => `arb:window:${pairKey}`,
  scanMeta: () => "arb:scan:meta",
} as const;

let redis: Redis | null = null;

function getArbRedis(): Redis | null {
  if (!isEvRedisEnabled()) return null;
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return redis;
}

export interface CachedArbWindowPayload {
  windows: ArbitrageWindow[];
  cachedAt: string;
}

export interface ArbScanMetaPayload {
  report: ArbitrageScanCoverageReport;
  recordedAt: string;
}

export async function getCachedArbWindows(
  pairKey: string
): Promise<CachedArbWindowPayload | null> {
  const client = getArbRedis();
  if (!client) return null;
  try {
    return client.get<CachedArbWindowPayload>(arbRedisKeys.window(pairKey));
  } catch {
    return null;
  }
}

export async function setCachedArbWindows(
  pairKey: string,
  windows: ArbitrageWindow[]
): Promise<void> {
  const client = getArbRedis();
  if (!client) return;
  try {
    await client.set(
      arbRedisKeys.window(pairKey),
      {
        windows,
        cachedAt: new Date().toISOString(),
      } satisfies CachedArbWindowPayload,
      { ex: ARB_WINDOW_CACHE_TTL_SEC }
    );
  } catch {
    // Cache is optional — scan still succeeds without persistence.
  }
}

export async function getArbScanMeta(): Promise<ArbScanMetaPayload | null> {
  const client = getArbRedis();
  if (!client) return null;
  try {
    return client.get<ArbScanMetaPayload>(arbRedisKeys.scanMeta());
  } catch {
    return null;
  }
}

export async function setArbScanMeta(
  report: ArbitrageScanCoverageReport
): Promise<void> {
  const client = getArbRedis();
  if (!client) return;
  try {
    await client.set(
      arbRedisKeys.scanMeta(),
      {
        report,
        recordedAt: new Date().toISOString(),
      } satisfies ArbScanMetaPayload,
      { ex: ARB_SCAN_META_TTL_SEC }
    );
  } catch {
    // Meta cache is optional.
  }
}
