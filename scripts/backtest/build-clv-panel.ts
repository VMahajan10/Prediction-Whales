#!/usr/bin/env tsx
/**
 * Stage 1 — extract ledger fills, resolve markets, materialize per-fill CLV.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/backtest/build-clv-panel.ts \
 *     --rank-start 2024-01-01 --rank-end 2024-12-31 --min-trades 40
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import "../preload-env";

import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";

import { closingLineLeakageShare } from "@/lib/backtest/closingLineService";
import { buildClvMarkdownReport, formatClvCents } from "@/lib/backtest/clvReport";
import { dataApiExtractableRate, extractFillsFromDataApi } from "@/lib/backtest/dataApiFills";
import {
  evaluateFillSources,
  formatEvaluationMarkdown,
} from "@/lib/backtest/fillSourceEvaluation";
import {
  ClosingLineFileCache,
  computeClvForFills,
  rankWalletsByClv,
} from "@/lib/backtest/clvTrade";
import {
  DEFAULT_CLOSING_LINE_POLICY,
  resolveMarketSchedule,
  type MarketSchedule,
} from "@/lib/backtest/marketSchedule";
import { MarketTradeTapeCache } from "@/lib/backtest/marketTradeTape";
import { heldAssetSettlement } from "@/lib/backtest/filters";
import { applyClvMarketGate } from "@/lib/backtest/clvMarketGate";
import { gammaToMarketResolution, outcomeLabelForToken } from "@/lib/backtest/marketMeta";
import { supplementResolutionFromClob } from "@/lib/backtest/resolveMarketClose";
import type {
  BacktestFill,
  BacktestWindowConfig,
  ClvPanelExport,
  ClvPanelStats,
  MarketResolution,
  TradeClvRecord,
} from "@/lib/backtest/types";
import { buildWalletFunnel } from "@/lib/backtest/walletFunnel";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  walletHistoryCoverage,
  walletLedgerEvents,
} from "@/lib/crossmarket/store/schema";
import { GammaResolutionCache } from "@/lib/walletLedger/gamma";

const TMP_DIR = join(process.cwd(), "tmp", "backtest");
/** v2 schema — ignores legacy cache rows that produced uniform 0.75 lines. */
const CLOSING_LINES_PATH = join(TMP_DIR, "closing-lines-v3.jsonl");

function parseArgs(
  argv: string[]
): BacktestWindowConfig & { minTrades: number; reportPath: string } {
  let rankStart = "2024-01-01";
  let rankEnd = "2024-02-29";
  let minTrades = 40;
  let preCloseMinutes = 5;
  let clvResolutionMode: "ranking" | "final" = "final";
  let fillSource: "data-api" | "ledger" = "data-api";
  let preTradingEndHours = 1;
  let vwapTradeCount = 10;
  let minTapeTrades = 3;
  let reportPath = join(TMP_DIR, "clv-report.md");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rank-start" && argv[i + 1]) {
      rankStart = argv[++i];
    } else if (arg === "--rank-end" && argv[i + 1]) {
      rankEnd = argv[++i];
    } else if (arg === "--min-trades" && argv[i + 1]) {
      minTrades = Number(argv[++i]);
    } else if (arg === "--pre-close-minutes" && argv[i + 1]) {
      preCloseMinutes = Number(argv[++i]);
    } else if (arg === "--report-out" && argv[i + 1]) {
      reportPath = argv[++i];
    } else if (arg === "--clv-resolution-mode" && argv[i + 1]) {
      const mode = argv[++i];
      if (mode === "ranking" || mode === "final") {
        clvResolutionMode = mode;
      }
    } else if (arg === "--fill-source" && argv[i + 1]) {
      const src = argv[++i];
      if (src === "data-api" || src === "ledger") fillSource = src;
    } else if (arg === "--pre-trading-end-hours" && argv[i + 1]) {
      preTradingEndHours = Number(argv[++i]);
    } else if (arg === "--vwap-trades" && argv[i + 1]) {
      vwapTradeCount = Number(argv[++i]);
    } else if (arg === "--min-tape-trades" && argv[i + 1]) {
      minTapeTrades = Number(argv[++i]);
    }
  }

  return {
    rankStart,
    rankEnd,
    minTradesPerWallet: minTrades,
    preCloseMinutes,
    clvResolutionMode,
    fillSource,
    preTradingEndHours,
    vwapTradeCount,
    minTapeTrades,
    minTrades,
    reportPath,
  };
}

function dateToUnixStart(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00.000Z`) / 1000);
}

function dateToUnixEnd(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T23:59:59.999Z`) / 1000);
}

function fillKey(f: BacktestFill): string {
  return `${f.walletAddress}:${f.timestamp}:${f.assetId}:${f.price}`;
}

function ledgerRowToFill(row: {
  walletAddress: string;
  marketConditionId: string | null;
  assetId: string | null;
  price: number | null;
  shares: number | null;
  cashUsd: number | null;
  blockTimestamp: number | null;
}): BacktestFill | null {
  if (
    !row.marketConditionId ||
    !row.assetId ||
    row.blockTimestamp == null ||
    row.blockTimestamp <= 0 ||
    row.price == null ||
    !Number.isFinite(row.price) ||
    row.price <= 0
  ) {
    return null;
  }
  const shares =
    row.shares != null && Number.isFinite(row.shares) ? row.shares : 0;
  const sizeUsd =
    row.cashUsd != null && Number.isFinite(row.cashUsd) && row.cashUsd > 0
      ? row.cashUsd
      : shares > 0
        ? shares * row.price
        : 0;
  if (sizeUsd <= 0) return null;

  return {
    walletAddress: row.walletAddress.toLowerCase(),
    conditionId: row.marketConditionId.trim().toLowerCase(),
    assetId: row.assetId.trim(),
    side: "BUY",
    price: row.price,
    sizeUsd,
    shares: shares > 0 ? shares : sizeUsd / row.price,
    timestamp: row.blockTimestamp,
  };
}

async function loadHydratedWallets(): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ wallet: walletHistoryCoverage.walletAddress })
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.historyComplete, true));
  return rows.map((r) => r.wallet.toLowerCase());
}

async function countLedgerBuysPerWallet(
  wallets: string[],
  rankStartUnix: number,
  rankEndUnix: number
): Promise<{
  allBuys: Map<string, number>;
  extractableBuys: Map<string, number>;
  totalAll: number;
  totalExtractable: number;
}> {
  const allBuys = new Map<string, number>();
  const extractableBuys = new Map<string, number>();
  let totalAll = 0;
  let totalExtractable = 0;
  if (wallets.length === 0) {
    return { allBuys, extractableBuys, totalAll, totalExtractable };
  }
  const db = getDb();
  const chunkSize = 200;
  for (let i = 0; i < wallets.length; i += chunkSize) {
    const chunk = wallets.slice(i, i + chunkSize);
    const rows = await db
      .select({
        wallet: sql<string>`lower(${walletLedgerEvents.walletAddress})`,
        count: sql<number>`count(*)::int`,
      })
      .from(walletLedgerEvents)
      .where(
        and(
          sql`lower(${walletLedgerEvents.walletAddress}) IN (${sql.join(
            chunk.map((w) => sql`${w}`),
            sql`, `
          )})`,
          eq(walletLedgerEvents.eventType, "BUY"),
          gte(walletLedgerEvents.blockTimestamp, rankStartUnix),
          lte(walletLedgerEvents.blockTimestamp, rankEndUnix)
        )
      )
      .groupBy(sql`lower(${walletLedgerEvents.walletAddress})`);
    for (const row of rows) {
      allBuys.set(row.wallet.toLowerCase(), row.count);
      totalAll += row.count;
    }

    const extractRows = await db
      .select({
        wallet: sql<string>`lower(${walletLedgerEvents.walletAddress})`,
        count: sql<number>`count(*)::int`,
      })
      .from(walletLedgerEvents)
      .where(
        and(
          sql`lower(${walletLedgerEvents.walletAddress}) IN (${sql.join(
            chunk.map((w) => sql`${w}`),
            sql`, `
          )})`,
          eq(walletLedgerEvents.eventType, "BUY"),
          isNotNull(walletLedgerEvents.marketConditionId),
          isNotNull(walletLedgerEvents.assetId),
          isNotNull(walletLedgerEvents.blockTimestamp),
          gte(walletLedgerEvents.blockTimestamp, rankStartUnix),
          lte(walletLedgerEvents.blockTimestamp, rankEndUnix)
        )
      )
      .groupBy(sql`lower(${walletLedgerEvents.walletAddress})`);
    for (const row of extractRows) {
      extractableBuys.set(row.wallet.toLowerCase(), row.count);
      totalExtractable += row.count;
    }
  }
  return { allBuys, extractableBuys, totalAll, totalExtractable };
}

async function extractFills(
  wallets: string[],
  rankStartUnix: number,
  rankEndUnix: number
): Promise<{ fills: BacktestFill[]; rawRows: number; parseDropped: number }> {
  if (wallets.length === 0) {
    return { fills: [], rawRows: 0, parseDropped: 0 };
  }
  const db = getDb();
  const fills: BacktestFill[] = [];
  let rawRows = 0;
  let parseDropped = 0;

  const chunkSize = 200;
  for (let i = 0; i < wallets.length; i += chunkSize) {
    const chunk = wallets.slice(i, i + chunkSize);
    const rows = await db
      .select({
        walletAddress: walletLedgerEvents.walletAddress,
        marketConditionId: walletLedgerEvents.marketConditionId,
        assetId: walletLedgerEvents.assetId,
        price: walletLedgerEvents.price,
        shares: walletLedgerEvents.shares,
        cashUsd: walletLedgerEvents.cashUsd,
        blockTimestamp: walletLedgerEvents.blockTimestamp,
      })
      .from(walletLedgerEvents)
      .where(
        and(
          sql`lower(${walletLedgerEvents.walletAddress}) IN (${sql.join(
            chunk.map((w) => sql`${w}`),
            sql`, `
          )})`,
          eq(walletLedgerEvents.eventType, "BUY"),
          isNotNull(walletLedgerEvents.marketConditionId),
          isNotNull(walletLedgerEvents.assetId),
          isNotNull(walletLedgerEvents.blockTimestamp),
          gte(walletLedgerEvents.blockTimestamp, rankStartUnix),
          lte(walletLedgerEvents.blockTimestamp, rankEndUnix)
        )
      );

    rawRows += rows.length;
    for (const row of rows) {
      const fill = ledgerRowToFill({
        ...row,
        walletAddress: row.walletAddress.toLowerCase(),
      });
      if (fill) fills.push(fill);
      else parseDropped += 1;
    }
  }

  return { fills, rawRows, parseDropped };
}

function enrichFills(
  fills: BacktestFill[],
  resolutions: Map<string, MarketResolution>
): BacktestFill[] {
  return fills.map((fill) => {
    const resolution = resolutions.get(fill.conditionId);
    if (!resolution) return fill;
    return {
      ...fill,
      marketTitle: resolution.marketTitle ?? null,
      outcome: outcomeLabelForToken(resolution, fill.assetId),
    };
  });
}

async function resolveMarkets(
  fills: BacktestFill[]
): Promise<Map<string, MarketResolution>> {
  const gammaCache = new GammaResolutionCache();
  const byCondition = new Map<string, { assets: Set<string> }>();

  for (const fill of fills) {
    const existing = byCondition.get(fill.conditionId) ?? { assets: new Set() };
    existing.assets.add(fill.assetId);
    byCondition.set(fill.conditionId, existing);
  }

  const resolutions = new Map<string, MarketResolution>();
  for (const conditionId of byCondition.keys()) {
    const assets = [...(byCondition.get(conditionId)?.assets ?? [])];
    const gamma = await gammaCache.resolve(conditionId, {
      conditionId,
      slugs: [],
      assets,
    });
    let resolution = gammaToMarketResolution(gamma);
    resolution = await supplementResolutionFromClob(resolution, assets);
    resolutions.set(conditionId, resolution);
  }

  return resolutions;
}

async function resolveSchedules(
  fills: BacktestFill[],
  resolutions: Map<string, MarketResolution>,
  config: BacktestWindowConfig
): Promise<Map<string, MarketSchedule>> {
  const hintsByCondition = new Map<
    string,
    { eventSlug?: string | null; marketSlug?: string | null }
  >();
  for (const fill of fills) {
    const h = hintsByCondition.get(fill.conditionId) ?? {};
    if (fill.eventSlug) h.eventSlug = fill.eventSlug;
    if (fill.marketSlug) h.marketSlug = fill.marketSlug;
    hintsByCondition.set(fill.conditionId, h);
  }

  const schedules = new Map<string, MarketSchedule>();
  const policy = {
    preTradingEndHours: config.preTradingEndHours,
    vwapTradeCount: config.vwapTradeCount,
    minTapeTrades: config.minTapeTrades,
  };

  for (const conditionId of new Set(fills.map((f) => f.conditionId))) {
    const resolution = resolutions.get(conditionId);
    if (!resolution) continue;
    const schedule = await resolveMarketSchedule(
      resolution,
      hintsByCondition.get(conditionId) ?? {},
      policy
    );
    schedules.set(conditionId, schedule);
  }
  return schedules;
}

function buildMarketExclusions(
  fills: BacktestFill[],
  resolutions: Map<string, MarketResolution>,
  schedules: Map<string, MarketSchedule>,
  config: BacktestWindowConfig,
  rankEndUnix: number
): {
  marketExcluded: Map<string, TradeClvRecord["exclusionReason"]>;
  rankingEligibleByFill: Map<string, boolean>;
  settledByFill: Map<string, 0 | 1>;
  stats: Pick<
    ClvPanelStats,
    | "preCloseExcluded"
    | "unresolvedMarketExcluded"
    | "postResolutionExcluded"
    | "unresolvedAtWindowEndExcluded"
    | "fillsAfterMarketFilters"
  >;
} {
  const marketExcluded = new Map<string, TradeClvRecord["exclusionReason"]>();
  const rankingEligibleByFill = new Map<string, boolean>();
  const settledByFill = new Map<string, 0 | 1>();
  let preCloseExcluded = 0;
  let unresolvedMarketExcluded = 0;
  let postResolutionExcluded = 0;
  let unresolvedAtWindowEndExcluded = 0;
  let fillsAfterMarketFilters = 0;

  for (const fill of fills) {
    const key = fillKey(fill);
    const resolution = resolutions.get(fill.conditionId);
    const schedule = schedules.get(fill.conditionId);
    const filter = applyClvMarketGate(
      fill,
      resolution,
      schedule,
      config,
      rankEndUnix
    );

    rankingEligibleByFill.set(key, filter.rankingEligible);

    if (!filter.pass) {
      marketExcluded.set(key, filter.reason);
      switch (filter.reason) {
        case "pre_close":
          preCloseExcluded += 1;
          break;
        case "post_resolution_fill":
        case "after_closing_cutoff":
          postResolutionExcluded += 1;
          break;
        case "unresolved_at_window_end":
          unresolvedAtWindowEndExcluded += 1;
          break;
        default:
          unresolvedMarketExcluded += 1;
          break;
      }
      continue;
    }

    const settled = heldAssetSettlement(fill, resolution) ?? 1;

    settledByFill.set(key, settled);
    rankingEligibleByFill.set(key, filter.rankingEligible);
    fillsAfterMarketFilters += 1;
  }

  return {
    marketExcluded,
    rankingEligibleByFill,
    settledByFill,
    stats: {
      preCloseExcluded,
      unresolvedMarketExcluded,
      postResolutionExcluded,
      unresolvedAtWindowEndExcluded,
      fillsAfterMarketFilters,
    },
  };
}

function sampleRandom<T>(items: T[], n: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function printWalletFunnelLog(
  funnel: ReturnType<typeof buildWalletFunnel>,
  ledgerCounts: Map<string, number>
): void {
  const withLedger = [...ledgerCounts.values()].filter((c) => c > 0).length;
  const zeroLedger = funnel.filter((w) => w.ledgerBuyRowsInWindow === 0).length;
  console.log(
    `\nWallet funnel: ${withLedger} wallets with ledger BUY rows in window; ${zeroLedger} hydrated wallets with 0 rows`
  );
  console.log(
    "Top wallets (ledger → parsed → after filters → valid CLV):"
  );
  for (const row of funnel.filter((w) => w.ledgerBuyRowsInWindow > 0).slice(0, 25)) {
    console.log(
      `  ${row.walletAddress.slice(0, 12)}… ledger=${row.ledgerBuyRowsInWindow} extractable=${row.ledgerBuyRowsExtractable} parsed=${row.parsedFills} filtered=${row.afterMarketFilters} clv=${row.validClv} topExcl=${row.topExclusionReason ?? "—"}`
    );
  }
}

function printReport(
  config: BacktestWindowConfig,
  stats: ClvPanelStats,
  records: TradeClvRecord[],
  verificationSamples: TradeClvRecord[]
): void {
  const validClv = records.filter((r) => r.isValidClv).length;
  const pctPreClose =
    stats.fillsExtracted > 0
      ? ((stats.preCloseExcluded / stats.fillsExtracted) * 100).toFixed(1)
      : "0.0";
  const pctValid =
    stats.fillsExtracted > 0
      ? ((validClv / stats.fillsExtracted) * 100).toFixed(1)
      : "0.0";

  const uniqueClosing = new Set(
    records.filter((r) => r.isValidClv).map((r) => r.closingLinePrice)
  );

  console.log("\n── CLV panel Stage 1 QA ──\n");
  console.log(`Window: ${config.rankStart} → ${config.rankEnd}`);
  console.log(`Hydrated wallets: ${stats.hydratedWalletCount}`);
  console.log(
    `Wallets with ledger BUY in window: ${stats.walletsWithAnyLedgerBuyInWindow}`
  );
  console.log(`Fills extracted: ${stats.fillsExtracted}`);
  console.log(`After market filters: ${stats.fillsAfterMarketFilters}`);
  console.log(`Valid CLV fills: ${validClv} (${pctValid}% of extracted)`);
  console.log(`Missing closing price: ${stats.missingClosingPrice}`);
  console.log(`Distinct closing lines (valid): ${uniqueClosing.size}`);
  console.log(
    `Closing-line leakage share: ${(stats.closingLineLeakageShare * 100).toFixed(1)}% (close <5¢ or >95¢)`
  );
  console.log(`Fill source: ${stats.fillSource}`);
  if (stats.dataApiExtractableRate != null) {
    console.log(
      `Data API extractable rate: ${(stats.dataApiExtractableRate * 100).toFixed(1)}%`
    );
  }
  console.log(`Pre-close exclusions: ${stats.preCloseExcluded} (${pctPreClose}%)`);
  console.log(`Unresolved / disputed: ${stats.unresolvedMarketExcluded}`);
  console.log(`Post-resolution fills: ${stats.postResolutionExcluded}`);
  console.log(`Unresolved at window end: ${stats.unresolvedAtWindowEndExcluded}`);

  const ranked = rankWalletsByClv(records, config.minTradesPerWallet);
  const byUnweighted = [...ranked].sort(
    (a, b) =>
      (b.unweightedClvCents ?? -Infinity) - (a.unweightedClvCents ?? -Infinity)
  );

  console.log(
    `\nTop 10 wallets by size-weighted CLV (min ${config.minTradesPerWallet} qualifying trades):`
  );
  for (const row of ranked.slice(0, 10)) {
    console.log(
      `  ${row.walletAddress.slice(0, 10)}…  wCLV=${formatClvCents(row.weightedClvCents)}  uCLV=${formatClvCents(row.unweightedClvCents)}  trades=${row.qualifyingTrades} valid=${row.validClvTrades}`
    );
  }

  console.log("\n── 5 random trades for manual verification ──\n");
  for (const t of verificationSamples) {
    const entryC = Math.round(t.price * 1000) / 10;
    const closeC =
      t.closingLinePrice != null
        ? Math.round(t.closingLinePrice * 1000) / 10
        : null;
    console.log(`Market: ${t.marketTitle ?? "—"}`);
    console.log(`  market_id: ${t.marketId}`);
    console.log(`  outcome: ${t.outcome ?? "—"}  token_id: ${t.tokenId}`);
    console.log(`  entry: ${entryC}¢ @ ${new Date(t.timestamp * 1000).toISOString()}`);
    console.log(
      `  close: ${closeC != null ? `${closeC}¢` : "—"} @ ${t.closeTimestamp != null ? new Date(t.closeTimestamp * 1000).toISOString() : "—"}`
    );
    console.log(
      `  cutoff: ${t.closingCutoffUnix != null ? new Date(t.closingCutoffUnix * 1000).toISOString() : "—"}  source: ${t.closingLineSource ?? "—"}`
    );
    console.log(`  CLV: ${formatClvCents(t.clvCents)}\n`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const config: BacktestWindowConfig = {
    rankStart: parsed.rankStart,
    rankEnd: parsed.rankEnd,
    minTradesPerWallet: parsed.minTrades,
    preCloseMinutes: parsed.preCloseMinutes,
    clvResolutionMode: parsed.clvResolutionMode,
    fillSource: parsed.fillSource,
    preTradingEndHours: parsed.preTradingEndHours,
    vwapTradeCount: parsed.vwapTradeCount,
    minTapeTrades: parsed.minTapeTrades,
  };

  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL is not configured.");
    process.exit(1);
  }

  mkdirSync(TMP_DIR, { recursive: true });
  const fileCache = new ClosingLineFileCache(CLOSING_LINES_PATH);
  const tapeCache = new MarketTradeTapeCache();

  const rankStartUnix = dateToUnixStart(config.rankStart);
  const rankEndUnix = dateToUnixEnd(config.rankEnd);

  console.log("Evaluating fill sources (sample)…");
  const fillSourceEval = await evaluateFillSources(
    rankStartUnix,
    rankEndUnix,
    30
  );
  writeFileSync(
    join(TMP_DIR, "fill-source-evaluation.md"),
    formatEvaluationMarkdown(fillSourceEval),
    "utf8"
  );
  console.log(fillSourceEval.recommendation);

  console.log("Loading hydrated wallets…");
  const wallets = await loadHydratedWallets();
  const ledgerCounts = await countLedgerBuysPerWallet(
    wallets,
    rankStartUnix,
    rankEndUnix
  );
  const walletsWithBuys = [...ledgerCounts.allBuys.values()].filter(
    (n) => n > 0
  ).length;

  let rawFills: BacktestFill[] = [];
  let dataApiRate: number | null = null;
  console.log(
    `Extracting BUY fills (${wallets.length} hydrated wallets, source=${config.fillSource})…`
  );
  if (config.fillSource === "data-api") {
    const api = await extractFillsFromDataApi(
      wallets,
      rankStartUnix,
      rankEndUnix,
      6
    );
    rawFills = api.fills;
    dataApiRate = dataApiExtractableRate(
      api.buyRowsInWindow,
      api.extractableBuys
    );
    console.log(
      `Data API: ${api.rawTradeRows} rows fetched, ${api.buyRowsInWindow} BUY in window, ${api.extractableBuys} with ids (${(dataApiRate * 100).toFixed(1)}%), truncated wallets=${api.walletsTruncated}`
    );
  } else {
    const { fills, rawRows, parseDropped } = await extractFills(
      wallets,
      rankStartUnix,
      rankEndUnix
    );
    rawFills = fills;
    console.log(
      `Ledger BUY rows: ${ledgerCounts.totalAll} total, ${ledgerCounts.totalExtractable} extractable`
    );
    console.log(
      `Extract query rows: ${rawRows} (parse dropped ${parseDropped}) → ${rawFills.length} fills`
    );
  }
  console.log(
    `Ledger BUY rows (reference): ${ledgerCounts.totalAll} total, ${ledgerCounts.totalExtractable} extractable (condition+asset+ts)`
  );

  console.log(`Resolving ${new Set(rawFills.map((f) => f.conditionId)).size} markets (Gamma)…`);
  const resolutions = await resolveMarkets(rawFills);
  const fills = enrichFills(rawFills, resolutions);
  const schedules = await resolveSchedules(fills, resolutions, config);

  const {
    marketExcluded,
    rankingEligibleByFill,
    settledByFill,
    stats: filterStats,
  } = buildMarketExclusions(fills, resolutions, schedules, config, rankEndUnix);

  const closingPolicy = {
    ...DEFAULT_CLOSING_LINE_POLICY,
    preTradingEndHours: config.preTradingEndHours,
    vwapTradeCount: config.vwapTradeCount,
    minTapeTrades: config.minTapeTrades,
  };

  console.log(
    "Computing CLV (tape VWAP before cutoff; sports=game start, else trading end − buffer)…"
  );
  const records = await computeClvForFills(
    fills,
    settledByFill,
    schedules,
    resolutions,
    closingPolicy,
    tapeCache,
    fileCache,
    marketExcluded,
    rankingEligibleByFill
  );

  const validClvFills = records.filter((r) => r.isValidClv).length;
  const missingClosingPrice = records.filter(
    (r) =>
      r.exclusionReason === "missing_closing_price" ||
      r.exclusionReason === "no_history" ||
      r.exclusionReason === "no_point_before_close"
  ).length;

  const stats: ClvPanelStats = {
    hydratedWalletCount: wallets.length,
    walletsWithAnyLedgerBuyInWindow: walletsWithBuys,
    ledgerBuyRowsInWindow: ledgerCounts.totalAll,
    ledgerBuyRowsExtractable: ledgerCounts.totalExtractable,
    fillsExtracted: fills.length,
    ...filterStats,
    validClvFills,
    missingClosingPrice,
    closingLineLeakageShare: closingLineLeakageShare(records),
    fillSource: config.fillSource,
    dataApiExtractableRate: dataApiRate,
  };

  const walletFunnel = buildWalletFunnel(
    wallets,
    ledgerCounts.allBuys,
    ledgerCounts.extractableBuys,
    fills,
    records
  );
  printWalletFunnelLog(walletFunnel, ledgerCounts.allBuys);

  const validForVerify = records.filter((r) => r.isValidClv);
  const diverseValid = [
    ...new Map(
      validForVerify.map((r) => [`${r.marketId}:${r.tokenId}`, r] as const)
    ).values(),
  ];
  const verificationSamples = sampleRandom(diverseValid, 5);

  const ranked = rankWalletsByClv(records, config.minTradesPerWallet);
  const byUnweighted = [...ranked].sort(
    (a, b) =>
      (b.unweightedClvCents ?? -Infinity) - (a.unweightedClvCents ?? -Infinity)
  );

  const exportPayload: ClvPanelExport = {
    config,
    generatedAt: new Date().toISOString(),
    stats,
    walletFunnel,
    records,
  };

  const panelName = `clv-panel-${config.rankStart}_${config.rankEnd}.json`;
  const panelPath = join(TMP_DIR, panelName);
  writeFileSync(panelPath, JSON.stringify(exportPayload, null, 2), "utf8");

  const reportMd = buildClvMarkdownReport({
    config,
    stats,
    walletFunnel,
    rankedWeighted: ranked,
    rankedUnweighted: byUnweighted,
    verificationSamples,
  });
  writeFileSync(parsed.reportPath, reportMd, "utf8");

  printReport(config, stats, records, verificationSamples);
  console.log(`Panel written: ${panelPath}`);
  console.log(`Report written: ${parsed.reportPath}`);
  console.log(`Closing-line cache: ${CLOSING_LINES_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
