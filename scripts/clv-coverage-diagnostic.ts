/**
 * CLV coverage diagnostic across the current set of active whales.
 *
 * For each whale: how many closed bets qualify for a clean closing line vs.
 * fall back, plus the exclusion-reason breakdown. Aggregates the % of
 * whale-bets that qualify for CLV and the top exclusion reasons, and
 * classifies whether low coverage is GENUINE (no clean line existed) or
 * RECOVERABLE (a usable line existed but detection rejected it).
 *
 * Usage:
 *   npx tsx scripts/clv-coverage-diagnostic.ts
 *   npx tsx scripts/clv-coverage-diagnostic.ts --min-notional 1000 --whales 40
 *   npx tsx scripts/clv-coverage-diagnostic.ts 0xabc... 0xdef...   (explicit wallets)
 */
import {
  computeClvStats,
  fetchClosedPositions,
  isEphemeralClosedPosition,
} from "../lib/polymarket";
import {
  mapWithConcurrency,
  type ClosingLineExclusionReason,
} from "../lib/clvPriceHistory";

const TRADES_URL = "https://data-api.polymarket.com/trades";

interface Args {
  wallets: string[];
  minNotional: number;
  maxWhales: number;
  probeNoHistory: boolean;
  probeSample: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const wallets: string[] = [];
  let minNotional = 500;
  let maxWhales = 30;
  let probeNoHistory = false;
  let probeSample = 25;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--min-notional") minNotional = Number(argv[++i]);
    else if (a === "--whales") maxWhales = Number(argv[++i]);
    else if (a === "--probe-no-history") probeNoHistory = true;
    else if (a === "--probe-sample") probeSample = Number(argv[++i]);
    else if (a.startsWith("0x")) wallets.push(a.toLowerCase());
  }
  return { wallets, minNotional, maxWhales, probeNoHistory, probeSample };
}

const CLOB_PRICES_URL = "https://clob.polymarket.com/prices-history";

interface RawProbeResult {
  asset: string;
  title: string;
  status: "empty" | "has_data" | "http_error";
  httpStatus: number | null;
  points: number;
  /** Of the returned points, how many sit in the uncollapsed 0.1–0.9 band. */
  uncollapsedPoints: number;
}

/** Raw re-fetch using the SAME URL/params as production fetchPriceHistory. */
async function rawProbe(asset: string, title: string): Promise<RawProbeResult> {
  const url = `${CLOB_PRICES_URL}?market=${encodeURIComponent(asset)}&interval=max&fidelity=60`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return {
        asset,
        title,
        status: "http_error",
        httpStatus: res.status,
        points: 0,
        uncollapsedPoints: 0,
      };
    }
    const data = (await res.json()) as {
      history?: Array<{ t?: number; p?: number }>;
    };
    const history = Array.isArray(data.history) ? data.history : [];
    const pts = history.filter(
      (pt) => typeof pt.t === "number" && typeof pt.p === "number"
    );
    const uncollapsed = pts.filter(
      (pt) => (pt.p as number) >= 0.1 && (pt.p as number) <= 0.9
    ).length;
    return {
      asset,
      title,
      status: pts.length > 0 ? "has_data" : "empty",
      httpStatus: res.status,
      points: pts.length,
      uncollapsedPoints: uncollapsed,
    };
  } catch {
    return {
      asset,
      title,
      status: "http_error",
      httpStatus: null,
      points: 0,
      uncollapsedPoints: 0,
    };
  }
}

function sample<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/** Active whales = distinct wallets from the recent ≥minNotional trade feed. */
async function fetchActiveWhales(
  minNotional: number,
  maxWhales: number
): Promise<string[]> {
  const res = await fetch(`${TRADES_URL}?limit=500`);
  const trades = (await res.json()) as Array<{
    proxyWallet?: string;
    size?: number;
    price?: number;
  }>;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of trades) {
    const w = t.proxyWallet?.toLowerCase();
    if (!w || seen.has(w)) continue;
    const notional = (t.size ?? 0) * (t.price ?? 0);
    if (notional < minNotional) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= maxWhales) break;
  }
  return out;
}

// Was a usable pre-settlement line plausibly present? Used to split
// genuine-vs-recoverable.
const RECOVERABLE: ClosingLineExclusionReason[] = [
  "always_collapsed", // had ≥5 points but no uncollapsed point in 0.1–0.9 band
  "stale_line", // a line WAS found, just older than the freshness cap
];
const GENUINE: ClosingLineExclusionReason[] = [
  "no_history", // CLOB returned no price series at all
  "incomplete", // fewer than MIN_POINTS — no real curve to read
];
const DATA_ISSUE: ClosingLineExclusionReason[] = ["bad_entry"];

interface WhaleRow {
  wallet: string;
  totalClosed: number;
  coverage: number;
  fallback: number;
  coveragePct: number | null;
  /** CLV exclusion reasons over the non-ephemeral fallback set — sums to fallback. */
  reasons: Record<string, number>;
  /** Bot markets pre-filtered before CLV runs (not part of totalClosed). */
  ephemeralExcluded: number;
  /** Asset (CLOB token) ids excluded with reason no_history, for raw probing. */
  noHistoryAssets: Array<{ asset: string; title: string }>;
  /** Asset ids that DID qualify for CLV — used as a positive control for the probe. */
  qualifiedAssets: Array<{ asset: string; title: string }>;
}

async function diagnoseWhale(wallet: string): Promise<WhaleRow | null> {
  const closed = await fetchClosedPositions(wallet);
  const eligible = closed.filter((p) => !isEphemeralClosedPosition(p));
  const ephemeralExcluded = closed.length - eligible.length;
  if (closed.length === 0) return null;

  const stats = await computeClvStats(eligible);
  const positions = stats.positions ?? [];

  const reasons: Record<string, number> = {};
  const noHistoryAssets: Array<{ asset: string; title: string }> = [];
  const qualifiedAssets: Array<{ asset: string; title: string }> = [];
  for (const p of positions) {
    if (p.valid && p.clv != null) {
      if (p.asset) qualifiedAssets.push({ asset: p.asset, title: p.title });
      continue;
    }
    const r = p.reason ?? "unknown";
    reasons[r] = (reasons[r] ?? 0) + 1;
    if (r === "no_history" && p.asset) {
      noHistoryAssets.push({ asset: p.asset, title: p.title });
    }
  }

  const totalClosed = stats.totalClosed;
  const coverage = stats.coverage;
  const fallback = totalClosed - coverage;

  return {
    wallet,
    totalClosed,
    coverage,
    fallback,
    coveragePct: totalClosed > 0 ? (coverage / totalClosed) * 100 : null,
    reasons,
    ephemeralExcluded,
    noHistoryAssets,
    qualifiedAssets,
  };
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

async function main() {
  const { wallets, minNotional, maxWhales, probeNoHistory, probeSample } =
    parseArgs();
  const whales = wallets.length
    ? wallets
    : await fetchActiveWhales(minNotional, maxWhales);

  console.log(
    `Diagnosing CLV coverage across ${whales.length} active whale${whales.length === 1 ? "" : "s"} ` +
      (wallets.length ? "(explicit)" : `(≥ $${minNotional} recent trade)`) +
      "\n"
  );

  const rows: WhaleRow[] = [];
  for (const w of whales) {
    process.stderr.write(`  probing ${w.slice(0, 10)}…\n`);
    try {
      const row = await diagnoseWhale(w);
      if (row) rows.push(row);
    } catch (err) {
      process.stderr.write(`    skipped (${String(err)})\n`);
    }
  }

  // ---- Per-whale table ----
  console.log("=== PER-WHALE COVERAGE ===");
  console.log(
    "wallet        closed  CLV  fallback  coverage%  top exclusion"
  );
  for (const r of rows.sort((a, b) => (b.coveragePct ?? -1) - (a.coveragePct ?? -1))) {
    const topReason =
      Object.entries(r.reasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
    console.log(
      `${r.wallet.slice(0, 12)}  ${String(r.totalClosed).padStart(5)}  ${String(
        r.coverage
      ).padStart(3)}  ${String(r.fallback).padStart(7)}  ${(r.coveragePct != null
        ? r.coveragePct.toFixed(0) + "%"
        : "—"
      ).padStart(8)}  ${topReason}`
    );
  }

  // ---- Aggregate ----
  const totalBets = rows.reduce((s, r) => s + r.totalClosed, 0);
  const totalCovered = rows.reduce((s, r) => s + r.coverage, 0);
  const totalFallback = totalBets - totalCovered;
  const totalEphemeral = rows.reduce((s, r) => s + r.ephemeralExcluded, 0);

  const reasonTotals: Record<string, number> = {};
  for (const r of rows) {
    for (const [reason, n] of Object.entries(r.reasons)) {
      reasonTotals[reason] = (reasonTotals[reason] ?? 0) + n;
    }
  }

  let recoverable = 0;
  let genuine = 0;
  let dataIssue = 0;
  for (const [reason, n] of Object.entries(reasonTotals)) {
    if (RECOVERABLE.includes(reason as ClosingLineExclusionReason)) recoverable += n;
    else if (GENUINE.includes(reason as ClosingLineExclusionReason)) genuine += n;
    else if (DATA_ISSUE.includes(reason as ClosingLineExclusionReason)) dataIssue += n;
  }
  const totalExcluded = recoverable + genuine + dataIssue;

  console.log("\n=== AGGREGATE ===");
  console.log(`Whales analyzed:        ${rows.length}`);
  console.log(`Total closed bets:      ${totalBets}  (after bot pre-filter)`);
  console.log(
    `Qualify for CLV:        ${totalCovered}  (${pct(totalCovered, totalBets)})`
  );
  console.log(
    `Fall back (no CLV):     ${totalFallback}  (${pct(totalFallback, totalBets)})`
  );
  console.log(
    `Bot markets pre-filtered (not counted above): ${totalEphemeral}`
  );

  console.log("\n=== EXCLUSION REASONS (top first, % of fallback bets) ===");
  const sortedReasons = Object.entries(reasonTotals).sort(
    (a, b) => b[1] - a[1]
  );
  for (const [reason, n] of sortedReasons) {
    const bucket = RECOVERABLE.includes(reason as ClosingLineExclusionReason)
      ? "RECOVERABLE"
      : GENUINE.includes(reason as ClosingLineExclusionReason)
        ? "genuine"
        : DATA_ISSUE.includes(reason as ClosingLineExclusionReason)
          ? "data-issue"
          : "unknown";
    console.log(
      `  ${reason.padEnd(18)} ${String(n).padStart(4)}  (${pct(
        n,
        totalExcluded
      )} of excluded)  [${bucket}]`
    );
  }

  console.log("\n=== GENUINE vs RECOVERABLE ===");
  console.log(
    `  genuine (no clean line existed):  ${genuine}  (${pct(genuine, totalExcluded)})`
  );
  console.log(
    `    → no_history / incomplete: illiquid or political markets, no usable curve`
  );
  console.log(
    `  RECOVERABLE (line likely existed): ${recoverable}  (${pct(recoverable, totalExcluded)})`
  );
  console.log(
    `    → always_collapsed / stale_line: collapse-point detection may be too strict`
  );
  if (dataIssue > 0) {
    console.log(
      `  data-issue (bad_entry):           ${dataIssue}  (${pct(dataIssue, totalExcluded)})`
    );
  }

  console.log("\n=== VERDICT ===");
  if (totalExcluded === 0) {
    console.log("  No exclusions — full CLV coverage.");
  } else if (recoverable / totalExcluded >= 0.3) {
    console.log(
      `  ${pct(recoverable, totalExcluded)} of exclusions are RECOVERABLE — worth revisiting`
    );
    console.log(
      `  collapse detection (UNCOLLAPSED band ${0.1}-${0.9}, freshness cap 24h).`
    );
  } else {
    console.log(
      `  Low coverage is mostly GENUINE (${pct(genuine, totalExcluded)} of exclusions):`
    );
    console.log(
      `  these whales bet illiquid/political markets with no clean closing line.`
    );
  }

  const noHistory = reasonTotals["no_history"] ?? 0;
  if (noHistory / Math.max(1, totalExcluded) >= 0.5) {
    console.log(
      `\n  ⚠ CAVEAT: no_history dominates (${pct(noHistory, totalExcluded)} of exclusions).`
    );
    console.log(
      `  This is classed 'genuine', but an empty CLOB prices-history series can also`
    );
    console.log(
      `  mean a fetch/asset-id problem. Run --probe-no-history to settle it.`
    );
  }

  if (!probeNoHistory) return;

  // ---- Raw re-probe of no_history-excluded assets ----
  const allNoHistory = rows.flatMap((r) => r.noHistoryAssets);
  // Dedupe by asset id (closing line is wallet-agnostic).
  const uniqueByAsset = new Map<string, { asset: string; title: string }>();
  for (const a of allNoHistory) {
    if (!uniqueByAsset.has(a.asset)) uniqueByAsset.set(a.asset, a);
  }
  const pool = Array.from(uniqueByAsset.values());

  console.log("\n=== --probe-no-history: RAW RE-FETCH ===");
  console.log(
    `Unique no_history assets: ${pool.length}; sampling ${Math.min(
      probeSample,
      pool.length
    )} raw against clob.polymarket.com/prices-history\n`
  );

  // Positive control: prove the raw probe DOES see data when a curve exists,
  // so 100%-empty can't be dismissed as a bug in the probe itself.
  const qualifiedPool = Array.from(
    new Map(
      rows.flatMap((r) => r.qualifiedAssets).map((a) => [a.asset, a])
    ).values()
  );
  const controlPick = sample(qualifiedPool, Math.min(5, qualifiedPool.length));
  const controls = await mapWithConcurrency(controlPick, 6, (a) =>
    rawProbe(a.asset, a.title)
  );
  const controlWithData = controls.filter((c) => c.status === "has_data").length;
  console.log(
    `Control (CLV-qualified assets that SHOULD have data): ${controlWithData}/${controls.length} returned data`
  );
  if (controls.length > 0 && controlWithData === 0) {
    console.log(
      "  ⚠ Control failed — the probe returns empty even for known-good assets."
    );
    console.log(
      "  Treat the no_history result below as UNRELIABLE (probe/URL bug, not genuine).\n"
    );
  } else {
    console.log("  ✓ Control passed — probe correctly sees data when it exists.\n");
  }

  const picked = sample(pool, probeSample);
  const probes = await mapWithConcurrency(picked, 6, (a) =>
    rawProbe(a.asset, a.title)
  );

  let empty = 0;
  let hasData = 0;
  let hasUsable = 0;
  let httpErr = 0;
  for (const p of probes) {
    if (p.status === "empty") empty++;
    else if (p.status === "http_error") httpErr++;
    else {
      hasData++;
      if (p.uncollapsedPoints > 0) hasUsable++;
    }
    const tag =
      p.status === "empty"
        ? "EMPTY (genuine)"
        : p.status === "http_error"
          ? `HTTP ${p.httpStatus ?? "ERR"}`
          : `DATA ${p.points}pts / ${p.uncollapsedPoints} uncollapsed`;
    console.log(`  [${tag}] ${p.asset.slice(0, 14)}… ${p.title.slice(0, 46)}`);
  }

  const sampled = probes.length;
  console.log("\n=== PROBE SUMMARY ===");
  console.log(`Sampled:                       ${sampled}`);
  console.log(
    `Genuinely empty (no curve):    ${empty}  (${pct(empty, sampled)})`
  );
  console.log(
    `Returned price data:           ${hasData}  (${pct(hasData, sampled)})`
  );
  console.log(
    `  ↳ with usable (uncollapsed) line: ${hasUsable}  (${pct(hasUsable, sampled)})`
  );
  if (httpErr > 0) {
    console.log(
      `Transient HTTP error now:      ${httpErr}  (${pct(httpErr, sampled)})  — inconclusive`
    );
  }

  console.log("\n=== PROBE VERDICT ===");
  const wrongPct = (hasData / Math.max(1, sampled)) * 100;
  if (hasData === 0) {
    console.log(
      "  ~0% wrongly excluded — no_history is GENUINE. The 50% coverage is real; done."
    );
  } else if (wrongPct > 10) {
    console.log(
      `  ${wrongPct.toFixed(1)}% of sampled no_history assets DO return price data —`
    );
    console.log(
      `  this is a FETCH BUG recovering real coverage (likely transient errors cached`
    );
    console.log(
      `  permanently as no_history, or an asset-id/param mismatch). Worth fixing.`
    );
    if (httpErr > 0) {
      console.log(
        `  Note: ${httpErr} returned a transient HTTP error on re-probe — re-run to firm up.`
      );
    }
  } else {
    console.log(
      `  ${wrongPct.toFixed(1)}% returned data — minor; coverage is essentially real.`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
