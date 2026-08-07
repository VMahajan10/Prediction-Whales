/**
 * THROWAWAY BENCHMARK — p_true resolution latency + tier distribution.
 *
 * Measures the real resolution path used by the EV pipeline:
 *   resolvePTrueSync()  (lib/evPipeline/pTrueEnsembleResolver.ts)
 *   -> calculateTrueEV() (lib/finance/evEngine.ts)
 *
 * Market sample provenance, in priority order:
 *   1. "db"   — real rows from market_mappings + true_probabilities (spec-preferred)
 *   2. "live" — real live Polymarket markets + real CLOB order books
 *
 * Provenance is printed with the results, because the tier distribution is a
 * function of which inputs are populated: with the DB/Redis unavailable, the
 * inputs that feed tiers 1-3 are absent and the cascade necessarily collapses
 * to the lower tiers. Latency is provenance-independent; tier mix is not.
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/bench-ptrue-latency.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolvePTrueSync } from "@/lib/evPipeline/pTrueEnsembleResolver";
import type { PTrueResolveSyncInput, PTrueSource } from "@/lib/evPipeline/pTrueTypes";
import type { CachedOrderBookMid } from "@/lib/evPipeline/redisCache";
import { calculateTrueEV } from "@/lib/finance/evEngine";

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    let text: string;
    try {
      text = readFileSync(resolve(process.cwd(), file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const key = m[1];
      if (process.env[key]) continue;
      process.env[key] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// ---------------------------------------------------------------------------
// sample construction
// ---------------------------------------------------------------------------

const TARGET_SAMPLE = 120; // spec floor is 100
const GAMMA_URL = "https://gamma-api.polymarket.com/markets";
const CLOB_BOOK_URL = "https://clob.polymarket.com/book";

interface BenchMarket {
  label: string;
  input: PTrueResolveSyncInput;
}

/** Touch-based cached order-book mid, matching the pipeline's cache shape. */
function toCachedMid(
  bid: number | null,
  ask: number | null
): CachedOrderBookMid | null {
  if (
    bid == null ||
    ask == null ||
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid <= 0 ||
    ask <= 0 ||
    bid >= ask
  ) {
    return null;
  }
  return { bid, ask, mid: (bid + ask) / 2, ts: Date.now() };
}

async function loadFromDb(): Promise<BenchMarket[]> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT m.polymarket_token_id,
              m.kalshi_ticker,
              t.p_true::float8 AS p_true
         FROM market_mappings m
         LEFT JOIN true_probabilities t
                ON t.polymarket_token_id = m.polymarket_token_id
        WHERE m.polymarket_token_id IS NOT NULL
        ORDER BY m.confidence_score DESC NULLS LAST
        LIMIT $1`,
      [TARGET_SAMPLE]
    );

    return rows.map((r: Record<string, unknown>) => ({
      label: String(r.polymarket_token_id),
      input: {
        mappingPairKey: r.kalshi_ticker
          ? `${r.polymarket_token_id}:${r.kalshi_ticker}`
          : null,
        platform: "polymarket",
        pmMid: null,
        kalshiMid: null,
        exchangeMid: null,
        ensemblePTrue: r.p_true == null ? null : Number(r.p_true),
        executionPrice: null,
      } satisfies PTrueResolveSyncInput,
    }));
  } finally {
    await client.end();
  }
}

async function loadFromLive(): Promise<BenchMarket[]> {
  const tokens: Array<{ label: string; tokenId: string; last: number | null }> = [];
  const seen = new Set<string>();
  const PAGE = 100; // Gamma rejects larger pages on ordered queries.
  const MAX_PAGES = 20;

  // Paginate until the candidate pool comfortably exceeds the sample floor,
  // since a fraction of tokens have no two-sided book and get dropped.
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(
      `${GAMMA_URL}?limit=${PAGE}&offset=${page * PAGE}&active=true&closed=false&order=volumeNum&ascending=false`
    );
    if (!res.ok) throw new Error(`gamma ${res.status}`);
    const markets = (await res.json()) as Array<Record<string, unknown>>;
    if (markets.length === 0) break;

    for (const m of markets) {
      let ids: unknown = m.clobTokenIds;
      if (typeof ids === "string") {
        try {
          ids = JSON.parse(ids);
        } catch {
          continue;
        }
      }
      if (!Array.isArray(ids) || ids.length === 0) continue;
      const tokenId = String(ids[0]);
      if (seen.has(tokenId)) continue;
      seen.add(tokenId);
      const last = Number(m.lastTradePrice);
      tokens.push({
        label: String(m.slug ?? m.question ?? tokenId).slice(0, 60),
        tokenId,
        last: Number.isFinite(last) && last > 0 && last < 1 ? last : null,
      });
    }

    if (tokens.length >= TARGET_SAMPLE * 6) break;
  }

  // Real order books, fetched with bounded concurrency.
  const out: BenchMarket[] = [];
  const CONCURRENCY = 12;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < tokens.length && out.length < TARGET_SAMPLE) {
      const t = tokens[cursor++];
      if (!t) return;
      try {
        const r = await fetch(`${CLOB_BOOK_URL}?token_id=${t.tokenId}`);
        if (!r.ok) continue;
        const book = (await r.json()) as {
          bids?: Array<{ price: string; size: string }>;
          asks?: Array<{ price: string; size: string }>;
        };
        const bestBid = book.bids?.length
          ? Math.max(...book.bids.map((b) => parseFloat(b.price)))
          : null;
        const bestAsk = book.asks?.length
          ? Math.min(...book.asks.map((a) => parseFloat(a.price)))
          : null;
        const pmOb = toCachedMid(bestBid, bestAsk);
        if (!pmOb) continue;

        out.push({
          label: t.label,
          input: {
            mappingPairKey: null,
            platform: "polymarket",
            pmOb,
            kalshiOb: null,
            pmMid: pmOb.mid,
            kalshiMid: null,
            exchangeMid: null,
            ensemblePTrue: null,
            baselinePTrue: null,
            executionPrice: t.last,
          } satisfies PTrueResolveSyncInput,
        });
      } catch {
        // Skip unreachable books; sample floor is enforced by the caller.
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over an ascending-sorted array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1];
}

function fmtMs(ms: number): string {
  return ms >= 1 ? ms.toFixed(3) : ms.toFixed(5);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  let provenance = "db";
  let sample: BenchMarket[] = [];
  try {
    sample = await loadFromDb();
    if (sample.length === 0) throw new Error("db returned 0 rows");
  } catch (err) {
    console.log(
      `[sample] DB source unavailable (${(err as Error).message.split("\n")[0]}) — falling back to live Polymarket`
    );
    provenance = "live";
    sample = await loadFromLive();
  }

  if (sample.length < 100) {
    console.error(
      `FAILED: only ${sample.length} real markets available; spec requires >= 100.`
    );
    process.exit(1);
  }

  // Warm up JIT so steady-state cost is measured, not first-call compilation.
  for (let i = 0; i < 20_000; i++) {
    const m = sample[i % sample.length];
    const r = resolvePTrueSync(m.input);
    calculateTrueEV(r.pTrue, r.pmMid ?? r.marketPrior, "polymarket");
  }

  const ROUNDS = 40;
  const latenciesMs: number[] = [];
  const tierCounts = new Map<PTrueSource, number>();

  for (let round = 0; round < ROUNDS; round++) {
    for (const m of sample) {
      const t0 = process.hrtime.bigint();
      const resolved = resolvePTrueSync(m.input);
      calculateTrueEV(
        resolved.pTrue,
        resolved.pmMid ?? resolved.marketPrior,
        "polymarket"
      );
      const t1 = process.hrtime.bigint();
      latenciesMs.push(Number(t1 - t0) / 1e6);

      if (round === 0) {
        tierCounts.set(resolved.source, (tierCounts.get(resolved.source) ?? 0) + 1);
      }
    }
  }

  latenciesMs.sort((a, b) => a - b);
  const total = latenciesMs.length;
  const mean = latenciesMs.reduce((s, v) => s + v, 0) / total;

  console.log("");
  console.log("=== p_true resolution latency benchmark ===");
  console.log(`sample provenance : ${provenance}`);
  console.log(`markets           : ${sample.length}`);
  console.log(`rounds            : ${ROUNDS}`);
  console.log(`measured calls    : ${total}`);
  console.log(`node              : ${process.version}`);
  console.log("");
  console.log(`p50   : ${fmtMs(percentile(latenciesMs, 50))} ms`);
  console.log(`p95   : ${fmtMs(percentile(latenciesMs, 95))} ms`);
  console.log(`p99   : ${fmtMs(percentile(latenciesMs, 99))} ms`);
  console.log(`mean  : ${fmtMs(mean)} ms`);
  console.log(`min   : ${fmtMs(latenciesMs[0])} ms`);
  console.log(`max   : ${fmtMs(latenciesMs[total - 1])} ms`);
  console.log("");
  console.log(`=== tier resolution over ${sample.length} distinct markets ===`);
  const ordered = [...tierCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [source, count] of ordered) {
    const pct = ((count / sample.length) * 100).toFixed(1);
    console.log(`${source.padEnd(22)} ${String(count).padStart(4)}  ${pct}%`);
  }
  const prior = tierCounts.get("universal_prior") ?? 0;
  console.log("");
  console.log(
    `universal_prior fallthrough: ${prior}/${sample.length} (${((prior / sample.length) * 100).toFixed(1)}%)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
