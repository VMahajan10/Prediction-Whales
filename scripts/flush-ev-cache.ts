/**
 * Flush stale or all EV pipeline Redis cache keys.
 *
 * Usage:
 *   npm run flush:ev-cache                  # stale lookup entries only (default)
 *   npm run flush:ev-cache -- --all-lookups # all ev:v1:lookup:* keys
 *   npm run flush:ev-cache -- --all-ev      # entire ev:v1:* namespace
 *   npm run flush:ev-cache -- --dry-run     # scan only, no deletes
 */
import { loadEnvFiles } from "./loadEnv";

loadEnvFiles();

import {
  EV_REDIS_PREFIX,
  flushAllEvRedisKeys,
  flushEvLookupCache,
  isEvRedisEnabled,
  scanEvRedisKeys,
} from "../lib/evPipeline/redisCache";

function parseArgs(argv: string[]) {
  return {
    dryRun: argv.includes("--dry-run"),
    allLookups: argv.includes("--all-lookups"),
    allEv: argv.includes("--all-ev"),
    scanLimit: (() => {
      const idx = argv.indexOf("--scan-limit");
      if (idx === -1) return 10_000;
      const parsed = Number(argv[idx + 1]);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
    })(),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("\n── EV cache flush ──\n");

  if (!isEvRedisEnabled()) {
    console.error("UPSTASH_REDIS_REST_URL / TOKEN not configured.\n");
    process.exit(1);
  }

  if (args.dryRun) {
    const pattern = args.allEv
      ? `${EV_REDIS_PREFIX}:*`
      : `${EV_REDIS_PREFIX}:lookup:*`;
    const keys = await scanEvRedisKeys(pattern, args.scanLimit);
    console.log(`Dry run — would scan pattern: ${pattern}`);
    console.log(`Keys found: ${keys.length}`);
    if (keys[0]) console.log(`  sample: ${keys[0]}`);
    process.exit(0);
  }

  if (args.allEv) {
    const result = await flushAllEvRedisKeys(args.scanLimit);
    console.log(
      `Flushed all EV keys: scanned=${result.scanned} deleted=${result.deleted}`
    );
    process.exit(0);
  }

  const result = await flushEvLookupCache({
    staleOnly: !args.allLookups,
    scanLimit: args.scanLimit,
  });

  console.log(
    args.allLookups
      ? `Flushed all lookup keys: scanned=${result.scanned} deleted=${result.deleted}`
      : `Flushed stale lookup keys: scanned=${result.scanned} stale=${result.stale} deleted=${result.deleted}`
  );
  console.log("");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
