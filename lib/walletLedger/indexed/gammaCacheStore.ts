import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GammaMarketResolution } from "@/lib/walletLedger/types";

const CACHE_DIR = join(process.cwd(), "tmp", "wallet-history", "gamma");

function cachePath(): string {
  return join(CACHE_DIR, "condition-resolutions.json");
}

export function readPersistentGammaCache(): Map<string, GammaMarketResolution> {
  const path = cachePath();
  if (!existsSync(path)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      GammaMarketResolution
    >;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

export function writePersistentGammaCache(
  cache: Map<string, GammaMarketResolution>
): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const obj = Object.fromEntries(cache.entries());
  writeFileSync(cachePath(), JSON.stringify(obj));
}

export function mergePersistentGammaCache(
  cache: Map<string, GammaMarketResolution>
): void {
  const existing = readPersistentGammaCache();
  for (const [key, value] of cache.entries()) {
    existing.set(key, value);
  }
  writePersistentGammaCache(existing);
}

export function seedGammaCacheFromDisk(
  cache: Map<string, GammaMarketResolution>
): number {
  const disk = readPersistentGammaCache();
  let seeded = 0;
  for (const [key, value] of disk.entries()) {
    if (!cache.has(key)) {
      cache.set(key, value);
      seeded += 1;
    }
  }
  return seeded;
}

export function mergeGammaCacheToDisk(
  cache: Map<string, GammaMarketResolution>
): void {
  mergePersistentGammaCache(cache);
}
