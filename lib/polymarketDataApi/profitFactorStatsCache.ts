import { Redis } from "@upstash/redis";
import type { WalletProfitFactorStats } from "@/lib/walletProfitFactor";

const REDIS_KEY_PREFIX = "wallet:pf:stats:v1:";
/** In-memory (and Redis) TTL for resolved PF stats — default 10 minutes. */
export const WALLET_PF_STATS_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TTL_MS = WALLET_PF_STATS_CACHE_TTL_MS;

type CacheEntry = {
  stats: WalletProfitFactorStats;
  /** wallet_api_sync_state.updatedAt epoch ms when computed */
  syncUpdatedAt: number;
  cachedAt: number;
};

type GlobalPfCache = {
  memory: Map<string, CacheEntry>;
  inFlight: Map<string, Promise<WalletProfitFactorStats>>;
};

function cacheTtlMs(): number {
  const raw = process.env.WALLET_PF_STATS_CACHE_TTL_MS;
  if (raw == null || raw === "") return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

function getGlobalCache(): GlobalPfCache {
  const g = globalThis as typeof globalThis & {
    __walletPfStatsCache?: GlobalPfCache;
  };
  if (!g.__walletPfStatsCache) {
    g.__walletPfStatsCache = {
      memory: new Map(),
      inFlight: new Map(),
    };
  }
  return g.__walletPfStatsCache;
}

function normalizeWallet(wallet: string): string {
  return wallet.toLowerCase();
}

function isRedisEnabled(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (!isRedisEnabled()) return null;
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return redis;
}

function entryWithinTtl(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < cacheTtlMs();
}

function entryIsFresh(entry: CacheEntry, syncUpdatedAt: number): boolean {
  if (entry.syncUpdatedAt !== syncUpdatedAt) return false;
  return entryWithinTtl(entry);
}

/** Hot path: in-memory only, TTL expiry (no Redis / no sync row read). */
export function peekMemoryWalletProfitFactorStats(
  wallet: string
): WalletProfitFactorStats | null {
  const w = normalizeWallet(wallet);
  const mem = getGlobalCache().memory.get(w);
  if (!mem) return null;
  if (!entryWithinTtl(mem)) {
    getGlobalCache().memory.delete(w);
    return null;
  }
  return mem.stats;
}

export function invalidateWalletProfitFactorStatsCache(wallet: string): void {
  const w = normalizeWallet(wallet);
  getGlobalCache().memory.delete(w);
  const client = getRedis();
  if (client) {
    void client.del(`${REDIS_KEY_PREFIX}${w}`).catch(() => {});
  }
}

export async function getCachedWalletProfitFactorStats(
  wallet: string,
  syncUpdatedAt: number
): Promise<WalletProfitFactorStats | null> {
  const w = normalizeWallet(wallet);
  const mem = getGlobalCache().memory.get(w);
  if (mem && entryIsFresh(mem, syncUpdatedAt)) {
    return mem.stats;
  }

  const client = getRedis();
  if (!client) return null;

  try {
    const raw = await client.get<CacheEntry | string>(`${REDIS_KEY_PREFIX}${w}`);
    if (!raw) return null;
    const entry =
      typeof raw === "string" ? (JSON.parse(raw) as CacheEntry) : raw;
    if (!entry?.stats || !entryIsFresh(entry, syncUpdatedAt)) return null;
    getGlobalCache().memory.set(w, entry);
    return entry.stats;
  } catch {
    return null;
  }
}

export async function setCachedWalletProfitFactorStats(
  wallet: string,
  stats: WalletProfitFactorStats,
  syncUpdatedAt: number
): Promise<void> {
  const w = normalizeWallet(wallet);
  const entry: CacheEntry = {
    stats,
    syncUpdatedAt,
    cachedAt: Date.now(),
  };
  getGlobalCache().memory.set(w, entry);

  const client = getRedis();
  if (!client) return;

  try {
    const ttlSec = Math.max(60, Math.ceil(cacheTtlMs() / 1000));
    await client.set(`${REDIS_KEY_PREFIX}${w}`, entry, { ex: ttlSec });
  } catch {
    // memory cache still valid
  }
}

/** Dedupe concurrent resolves for the same wallet (directory / profile burst). */
export function coalesceWalletProfitFactorStats<T>(
  wallet: string,
  fn: () => Promise<T>
): Promise<T> {
  const w = normalizeWallet(wallet);
  const { inFlight } = getGlobalCache();
  const existing = inFlight.get(w);
  if (existing) {
    return existing as Promise<T>;
  }
  const promise = fn().finally(() => {
    inFlight.delete(w);
  });
  inFlight.set(w, promise as Promise<WalletProfitFactorStats>);
  return promise;
}
