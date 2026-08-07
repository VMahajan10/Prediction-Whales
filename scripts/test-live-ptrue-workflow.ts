/**
 * End-to-end live p_true workflow test.
 *
 * Mirrors the live feed path:
 *   Polymarket Data API / Kalshi trades API
 *     → POST /api/ev/trades (or direct ensureFullyComputedTradeEv)
 *     → p_true + signed EV payload
 *
 * Usage:
 *   npm run test:live-ptrue
 *   npm run test:live-ptrue -- --warm-ob
 *   npm run test:live-ptrue -- --api http://localhost:3000
 *   npm run test:live-ptrue -- --pm-limit 50 --kalshi-limit 50
 */
import { loadEnvFiles } from "./loadEnv";

loadEnvFiles();

import { fetchKalshiTrades } from "../lib/kalshiTradesServer";
import type { FeedTrade } from "../lib/feedTradeTypes";
import { fetchTrades, fetchWhaleBackfill } from "../lib/polymarket";
import {
  ensureFullyComputedTradeEv,
  loadMappingForTradeEv,
} from "../lib/evPipeline/resolveTradeEv";
import { initGlobalLocalEvCache } from "../lib/evPipeline/redisCache";
import { runOrderBookIngest } from "../lib/evPipeline/orderBookIngest";
import {
  coalesceDisplayEvPercent,
  resolvePipelineDisplayEv,
} from "../lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "../lib/evPipeline/types";
import {
  pipelineEvLookupKeyKalshi,
  pipelineEvLookupKeyPm,
} from "../lib/evPipeline/types";
import type { PipelineTradeEvInput } from "../lib/evPipeline/resolveTradeEv";

interface LiveSample {
  source: "polymarket" | "kalshi";
  label: string;
  input: PipelineTradeEvInput;
  lookupKey: string;
}

interface RowResult {
  sample: LiveSample;
  payload: PipelineTradeEv;
  hasPTrue: boolean;
  hasDisplayEv: boolean;
}

function parseArgs(argv: string[]) {
  return {
    warmOb: argv.includes("--warm-ob"),
    apiBase: (() => {
      const idx = argv.indexOf("--api");
      return idx === -1 ? null : argv[idx + 1] ?? "http://localhost:3000";
    })(),
    pmLimit: (() => {
      const idx = argv.indexOf("--pm-limit");
      const n = idx === -1 ? 40 : Number(argv[idx + 1]);
      return Number.isFinite(n) && n > 0 ? n : 40;
    })(),
    kalshiLimit: (() => {
      const idx = argv.indexOf("--kalshi-limit");
      const n = idx === -1 ? 40 : Number(argv[idx + 1]);
      return Number.isFinite(n) && n > 0 ? n : 40;
    })(),
  };
}

async function loadLiveSamples(
  pmLimit: number,
  kalshiLimit: number
): Promise<LiveSample[]> {
  const [pmAll, pmWhale, kalshi] = await Promise.all([
    fetchTrades().catch(() => []),
    fetchWhaleBackfill().catch(() => []),
    fetchKalshiTrades().catch(() => [] as FeedTrade[]),
  ]);

  const pmSeen = new Set<string>();
  const samples: LiveSample[] = [];

  for (const trade of [...pmWhale, ...pmAll]) {
    const tokenId = trade.assetId?.trim();
    if (!tokenId || pmSeen.has(tokenId)) continue;
    pmSeen.add(tokenId);
    const lookupKey = pipelineEvLookupKeyPm(tokenId);
    samples.push({
      source: "polymarket",
      label: trade.title.slice(0, 72),
      lookupKey,
      input: {
        source: "polymarket",
        tokenId,
        tradePrice: trade.price,
      },
    });
    if (pmSeen.size >= pmLimit) break;
  }

  const kalshiSeen = new Set<string>();
  for (const trade of kalshi) {
    const ticker = trade.ticker?.trim();
    if (!ticker || kalshiSeen.has(ticker)) continue;
    kalshiSeen.add(ticker);
    samples.push({
      source: "kalshi",
      label: trade.title.slice(0, 72),
      lookupKey: pipelineEvLookupKeyKalshi(ticker),
      input: {
        source: "kalshi",
        kalshiTicker: ticker,
        tradePrice: trade.price,
      },
    });
    if (kalshiSeen.size >= kalshiLimit) break;
  }

  return samples;
}

async function resolveViaApi(
  apiBase: string,
  items: LiveSample[]
): Promise<Map<string, PipelineTradeEv>> {
  const res = await fetch(`${apiBase.replace(/\/$/, "")}/api/ev/trades`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: items.map((s) => ({
        source: s.input.source,
        tokenId: s.input.tokenId,
        kalshiTicker: s.input.kalshiTicker,
        tradePrice: s.input.tradePrice,
      })),
    }),
  });
  const data = (await res.json()) as {
    byKey?: Record<string, PipelineTradeEv>;
  };
  return new Map(Object.entries(data.byKey ?? {}));
}

async function resolveDirect(samples: LiveSample[]): Promise<RowResult[]> {
  const results: RowResult[] = [];
  for (const sample of samples) {
    const mapping = await loadMappingForTradeEv(
      sample.input.tokenId,
      sample.input.kalshiTicker
    );
    const payload = await ensureFullyComputedTradeEv(
      sample.lookupKey,
      sample.input,
      mapping
    );
    results.push({
      sample,
      payload,
      hasPTrue: payload.pTrue != null && Number.isFinite(payload.pTrue),
      hasDisplayEv: resolvePipelineDisplayEv(payload) != null,
    });
  }
  return results;
}

function printReport(results: RowResult[]): void {
  const total = results.length;
  const withPTrue = results.filter((r) => r.hasPTrue);
  const withEv = results.filter((r) => r.hasDisplayEv);
  const unmapped = results.filter((r) => r.payload.status === "unmapped");
  const lowConfidence = results.filter((r) => r.payload.pTrueLowConfidence);

  const bySource: Record<string, number> = {};
  for (const row of withPTrue) {
    const src = row.payload.pTrueSource ?? "unknown";
    bySource[src] = (bySource[src] ?? 0) + 1;
  }

  console.log("\n── Live p_true workflow results ──\n");
  console.log(`  samples:              ${total}`);
  console.log(
    `  identifiable p_true:    ${withPTrue.length} (${pct(withPTrue.length, total)})`
  );
  console.log(
    `  displayable EV:         ${withEv.length} (${pct(withEv.length, total)})`
  );
  console.log(`  unmapped (no id):     ${unmapped.length}`);
  console.log(`  low-confidence:       ${lowConfidence.length}`);
  console.log("\n  p_true tier breakdown:");
  for (const [source, count] of Object.entries(bySource).sort(
    (a, b) => b[1] - a[1]
  )) {
    console.log(`    ${source.padEnd(22)} ${count}`);
  }

  const failures = results.filter((r) => !r.hasPTrue);
  if (failures.length > 0) {
    console.log("\n  ✗ Missing p_true:");
    for (const row of failures.slice(0, 10)) {
      console.log(
        `    ${row.sample.source} ${row.sample.lookupKey} status=${row.payload.status}`
      );
    }
    if (failures.length > 10) {
      console.log(`    … and ${failures.length - 10} more`);
    }
  }

  console.log("\n  Sample rows:");
  for (const row of results.slice(0, 8)) {
    const p = row.payload;
    const ev = coalesceDisplayEvPercent(p);
    console.log(
      `    [${row.sample.source}] ${row.sample.label}`
    );
    console.log(
      `      key=${row.sample.lookupKey} status=${p.status} p_true=${fmt(p.pTrue)} source=${p.pTrueSource ?? "—"} ev=${ev != null ? `${ev.toFixed(1)}%` : "—"} low=${p.pTrueLowConfidence ? "yes" : "no"}`
    );
  }

  const pass = failures.length === 0 && total > 0;
  console.log(`\n── Verdict: ${pass ? "PASS ✓" : "FAIL ✗"} ──`);
  console.log(
    pass
      ? "  Every live sample with market identity received a finite p_true."
      : "  Some samples lacked p_true — check mappings, Redis OB cache, or asset ids.\n"
  );
}

function pct(n: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function fmt(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("\n── Live p_true workflow test ──\n");
  console.log(`  mode:       ${args.apiBase ? `API ${args.apiBase}` : "direct resolver"}`);
  console.log(`  warm OB:    ${args.warmOb}`);
  console.log(`  pm limit:   ${args.pmLimit}`);
  console.log(`  kalshi limit: ${args.kalshiLimit}`);

  initGlobalLocalEvCache();

  if (args.warmOb) {
    console.log("\nWarming order-book cache (ingestOrderBooks)…");
    const ob = await runOrderBookIngest();
    console.log(`  cached OB mids: ${ob.totalCached}`);
  }

  console.log("\nFetching live Polymarket + Kalshi trade samples…");
  const samples = await loadLiveSamples(args.pmLimit, args.kalshiLimit);
  console.log(`  loaded ${samples.length} unique market identities`);

  if (samples.length === 0) {
    console.error("\nNo live samples fetched — check network/API access.\n");
    process.exit(1);
  }

  let results: RowResult[];

  if (args.apiBase) {
    const byKey = await resolveViaApi(args.apiBase, samples);
    results = samples.map((sample) => {
      const payload =
        byKey.get(sample.lookupKey) ??
        ({
          key: sample.lookupKey,
          status: "error",
          tokenId: sample.input.tokenId ?? null,
          kalshiTicker: sample.input.kalshiTicker ?? null,
          netEvPercent: null,
          netEv: 0,
          grossEv: 0,
        } satisfies PipelineTradeEv);
      return {
        sample,
        payload,
        hasPTrue: payload.pTrue != null && Number.isFinite(payload.pTrue),
        hasDisplayEv: resolvePipelineDisplayEv(payload) != null,
      };
    });
  } else {
    results = await resolveDirect(samples);
  }

  printReport(results);

  const failed = results.filter((r) => !r.hasPTrue).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(
    "\nLive workflow test failed:",
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
