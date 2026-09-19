import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CACHE_DIR = join(process.cwd(), "tmp", "wallet-indexed-audit", "cache");

/** Etherscan checkpoints are the durable store; inline JSON caches blow V8 string limits. */
export function isIndexedLogCacheEnabled(providerId: string): boolean {
  return providerId !== "etherscan_v2";
}

export function cacheKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

export function readIndexedCache<T>(key: string): T | null {
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeIndexedCache<T>(key: string, value: T): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(
    join(CACHE_DIR, `${key}.json`),
    JSON.stringify(
      value,
      (_key, val) => (typeof val === "bigint" ? val.toString() : val),
      2
    )
  );
}
