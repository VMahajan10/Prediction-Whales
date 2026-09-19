#!/usr/bin/env tsx
/**
 * Policy A production impact preview — READ ONLY.
 * Does not mutate production, feed, or X-agent behavior.
 */
import "./preload-env";
import { and, desc, gte, sql } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  feedTrades,
  walletHistoricalMetrics,
  walletHistoryCoverage,
  xPostLog,
  type FeedTrade,
} from "@/lib/crossmarket/store/schema";
import {
  MIN_FEED_TRADE_EV_PCT,
  MIN_PRODUCT_FEED_STAKE_USD,
  meetsProductFeedEvThreshold,
  meetsProductFeedStakeThreshold,
  passesPolymarketFeedTraderGate,
} from "@/lib/feedQualification";
import { qualifyWalletsForFeed } from "@/lib/feedQualificationServer";
import { resolveStrictPolymarketTranslationFromPayload } from "@/lib/feed/persistedFeedTranslation";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { loadProductionCredibilitySnapshot } from "@/lib/walletLedger/indexed/shadow/productionProbe";
import type { TradePayload } from "@/lib/x-agent/gateTypes";

const WINDOWS_HOURS = [24, 48, 72] as const;

type PolicyADecision = "PASS" | "FAIL" | "UNKNOWN";

interface WalletPolicyAContext {
  decision: PolicyADecision;
  indexedDataValidity: boolean;
  unknownReason: string | null;
  completedPositions: number | null;
  realizedRoi: number | null;
  profitablePositionRate: number | null;
  productionCredible: boolean | null;
  productionGateReason: string | null;
}

interface EvaluatedFeedTrade {
  tradeId: string;
  wallet: string | null;
  tradedAt: Date;
  stakeUsd: number;
  tradeEvPercent: number;
  category: string | null;
  title: string;
  executionPriceCents: number | null;
  passesStakeGate: boolean;
  passesTradeEvGate: boolean;
  passesTranslationGate: boolean;
  passesProductionWalletGate: boolean;
  currentFeedVisible: boolean;
  policyADecision: PolicyADecision;
  policyAUnknownReason: string | null;
  policyAAvailable: boolean;
  projectedFeedVisible: boolean;
}

interface DetectionFunnel {
  totalDetectedTrades: number;
  passesStakeGate: number;
  passesProductionWalletGate: number;
  policyAAvailable: number;
  policyAPass: number;
  policyAFail: number;
  policyAUnknown: number;
  distinctWallets: number;
  distinctPolicyAPassWallets: number;
}

interface WindowReport {
  hours: number;
  detectionFunnel: DetectionFunnel;
  feedTrades: {
    totalInFeedHistory: number;
    passesTradeGatesOnly: number;
    passesProductionWalletGate: number;
    policyAAvailable: number;
    policyAPass: number;
    policyAFail: number;
    policyAUnknown: number;
    currentFeedVisible: number;
    projectedFeedVisible: number;
    absoluteReduction: number;
    percentReduction: number | null;
    distinctProductionQualifiedWallets: number;
    distinctPolicyAPassWallets: number;
    distinctWalletsBefore: number;
    distinctWalletsAfter: number;
    tradesPerWhaleBefore: number | null;
    tradesPerWhaleAfter: number | null;
    volumeFromPolicyAFailWalletsPct: number | null;
  };
  xAgent: {
    totalCandidates: number;
    currentlyGatePassed: number;
    remainEligibleWithPolicyA: number;
    rejectedByPolicyA: number;
    policyAUnknown: number;
  };
  quality: {
    pass: TradeQualityStats;
    fail: TradeQualityStats;
    unknown: TradeQualityStats;
  };
  unknownReasons: Record<string, number>;
}

interface TradeQualityStats {
  n: number;
  medianTradeEvPct: number | null;
  medianStakeUsd: number | null;
  medianExecutionPriceCents: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function pct(n: number, d: number): number | null {
  if (d === 0) return null;
  return (n / d) * 100;
}

function classifyPolicyAUnknownReason(input: {
  metrics: {
    credibilityMetricsValid: boolean | null;
    completedPositions: number | null;
    realizedRoi: number | null;
    profitablePositionRate: number | null;
    historyValidity: string | null;
    historyComplete?: boolean | null;
  } | null;
  coverage: { walletAddress: string } | null;
}): string {
  if (!input.metrics) {
    return input.coverage ? "missing_metrics" : "no_indexed_history";
  }
  if (
    input.metrics.historyValidity === "unusable" ||
    input.metrics.historyValidity === "partial-and-metrics-unsafe" ||
    input.metrics.historyValidity === "incomplete"
  ) {
    return "incomplete_history";
  }
  if (!input.metrics.credibilityMetricsValid) {
    return "indexed_data_invalid";
  }
  if (
    input.metrics.completedPositions == null ||
    (input.metrics.completedPositions ?? 0) <
      10
  ) {
    if (
      input.metrics.historyComplete === false ||
      input.metrics.historyValidity !== "complete"
    ) {
      return "incomplete_history";
    }
    return "insufficient_completed_positions";
  }
  if (
    input.metrics.realizedRoi == null ||
    input.metrics.profitablePositionRate == null ||
    !Number.isFinite(input.metrics.realizedRoi) ||
    !Number.isFinite(input.metrics.profitablePositionRate)
  ) {
    return "missing_metrics";
  }
  return "other";
}

async function loadWalletPolicyAContexts(
  wallets: string[]
): Promise<Map<string, WalletPolicyAContext>> {
  const unique = [...new Set(wallets.map((w) => w.toLowerCase()).filter(Boolean))];
  const map = new Map<string, WalletPolicyAContext>();
  if (unique.length === 0) return map;

  const db = getDb();
  const metricsRows = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      sql`${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION} AND ${walletHistoricalMetrics.walletAddress} IN (${sql.join(
        unique.map((w) => sql`${w}`),
        sql`, `
      )})`
    );
  const coverageRows = await db
    .select()
    .from(walletHistoryCoverage)
    .where(
      sql`${walletHistoryCoverage.walletAddress} IN (${sql.join(
        unique.map((w) => sql`${w}`),
        sql`, `
      )})`
    );

  const metricsBy = new Map(
    metricsRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );
  const coverageBy = new Map(
    coverageRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );

  const productionCache = new Map<
    string,
    Awaited<ReturnType<typeof loadProductionCredibilitySnapshot>>
  >();

  for (const wallet of unique) {
    const metrics = metricsBy.get(wallet) ?? null;
    const coverage = coverageBy.get(wallet) ?? null;
    const indexedDataValidity = Boolean(metrics?.credibilityMetricsValid);
    const verdict = evaluateHistoricalPerformanceVerdict({
      indexedDataValidity,
      historyValidity: metrics?.historyValidity,
      historyComplete: metrics?.historyComplete ?? undefined,
      completedPositionCount: metrics?.completedPositions ?? null,
      realizedRoi: metrics?.realizedRoi ?? null,
      profitablePositionRate: metrics?.profitablePositionRate ?? null,
      metricVersion: metrics?.metricVersion ?? null,
    });
    let production = productionCache.get(wallet);
    if (!production) {
      production = await loadProductionCredibilitySnapshot(wallet);
      productionCache.set(wallet, production);
    }
    const unknownReason =
      verdict.historicalPerformanceDecision === "UNKNOWN"
        ? classifyPolicyAUnknownReason({ metrics, coverage })
        : null;
    map.set(wallet, {
      decision: verdict.historicalPerformanceDecision,
      indexedDataValidity,
      unknownReason,
      completedPositions: metrics?.completedPositions ?? null,
      realizedRoi: metrics?.realizedRoi ?? null,
      profitablePositionRate: metrics?.profitablePositionRate ?? null,
      productionCredible: production.productionCredible,
      productionGateReason: production.productionGateReason,
    });
  }
  return map;
}

function evaluateFeedTrade(
  row: FeedTrade,
  walletQualifications: Awaited<ReturnType<typeof qualifyWalletsForFeed>>,
  policyAByWallet: Map<string, WalletPolicyAContext>
): EvaluatedFeedTrade {
  const wallet = row.proxyWallet?.trim().toLowerCase() ?? null;
  const stakeUsd = row.stakeAmount;
  const tradeEvPercent = row.averageEv;
  const passesStakeGate = meetsProductFeedStakeThreshold(stakeUsd);
  const passesTradeEvGate = meetsProductFeedEvThreshold(tradeEvPercent);
  const passesTranslationGate =
    resolveStrictPolymarketTranslationFromPayload(row.payload) != null;
  const qualification = wallet ? walletQualifications[wallet] : undefined;
  const passesProductionWalletGate = passesPolymarketFeedTraderGate(
    wallet,
    qualification
  );
  const policyA = wallet ? policyAByWallet.get(wallet) : undefined;
  const policyADecision: PolicyADecision = wallet
    ? (policyA?.decision ?? "UNKNOWN")
    : "UNKNOWN";
  const policyAAvailable =
    policyADecision === "PASS" || policyADecision === "FAIL";
  const currentFeedVisible =
    passesStakeGate &&
    passesTradeEvGate &&
    passesTranslationGate &&
    passesProductionWalletGate;
  const projectedFeedVisible =
    currentFeedVisible && policyADecision === "PASS";

  const payload = row.payload as Record<string, unknown>;
  const price =
    typeof payload.price === "number"
      ? payload.price
      : typeof payload.entryCents === "number"
        ? payload.entryCents
        : null;

  return {
    tradeId: row.tradeId,
    wallet,
    tradedAt: row.tradedAt,
    stakeUsd,
    tradeEvPercent,
    category: row.category,
    title: row.title,
    executionPriceCents: price,
    passesStakeGate,
    passesTradeEvGate,
    passesTranslationGate,
    passesProductionWalletGate,
    currentFeedVisible,
    policyADecision,
    policyAUnknownReason: policyA?.unknownReason ?? (wallet ? "no_indexed_history" : "no_wallet"),
    policyAAvailable,
    projectedFeedVisible,
  };
}

function summarizeQuality(trades: EvaluatedFeedTrade[]): TradeQualityStats {
  const ev = trades.map((t) => t.tradeEvPercent).filter(Number.isFinite);
  const stake = trades.map((t) => t.stakeUsd).filter(Number.isFinite);
  const price = trades
    .map((t) => t.executionPriceCents)
    .filter((v): v is number => v != null && Number.isFinite(v));
  return {
    n: trades.length,
    medianTradeEvPct: median(ev),
    medianStakeUsd: median(stake),
    medianExecutionPriceCents: median(price),
  };
}

function buildDetectionFunnel(
  xAgentRows: Array<{
    wallet: string;
    stakeUsd: number;
    passesProductionWalletGate: boolean;
    policyADecision: PolicyADecision;
    policyAAvailable: boolean;
  }>
): DetectionFunnel {
  const passWallets = new Set(
    xAgentRows
      .filter((r) => r.policyADecision === "PASS")
      .map((r) => r.wallet)
  );
  return {
    totalDetectedTrades: xAgentRows.length,
    passesStakeGate: xAgentRows.filter((r) =>
      meetsProductFeedStakeThreshold(r.stakeUsd)
    ).length,
    passesProductionWalletGate: xAgentRows.filter(
      (r) => r.passesProductionWalletGate
    ).length,
    policyAAvailable: xAgentRows.filter((r) => r.policyAAvailable).length,
    policyAPass: xAgentRows.filter((r) => r.policyADecision === "PASS").length,
    policyAFail: xAgentRows.filter((r) => r.policyADecision === "FAIL").length,
    policyAUnknown: xAgentRows.filter(
      (r) => r.policyADecision === "UNKNOWN"
    ).length,
    distinctWallets: new Set(xAgentRows.map((r) => r.wallet)).size,
    distinctPolicyAPassWallets: passWallets.size,
  };
}

function buildWindowReport(
  hours: number,
  allFeedTrades: EvaluatedFeedTrade[],
  xAgentRows: Array<{
    tradeId: string;
    gatePassed: boolean;
    wallet: string;
    stakeUsd: number;
    passesProductionWalletGate: boolean;
    policyADecision: PolicyADecision;
    policyAUnknownReason: string | null;
    policyAAvailable: boolean;
  }>
): WindowReport {
  const since = Date.now() - hours * 60 * 60 * 1000;
  const feed = allFeedTrades.filter((t) => t.tradedAt.getTime() >= since);
  const xAgent = xAgentRows;
  const detectionFunnel = buildDetectionFunnel(xAgent);

  const currentVisible = feed.filter((t) => t.currentFeedVisible);
  const projectedVisible = feed.filter((t) => t.projectedFeedVisible);
  const failVisibleTrades = currentVisible.filter(
    (t) => t.policyADecision === "FAIL"
  );

  const productionWallets = new Set(
    currentVisible.map((t) => t.wallet).filter(Boolean) as string[]
  );
  const policyAPassWallets = new Set(
    projectedVisible.map((t) => t.wallet).filter(Boolean) as string[]
  );

  const unknownReasons: Record<string, number> = {};
  for (const t of feed) {
    if (t.policyADecision !== "UNKNOWN") continue;
    const reason = t.policyAUnknownReason ?? "other";
    unknownReasons[reason] = (unknownReasons[reason] ?? 0) + 1;
  }

  const passTrades = feed.filter(
    (t) => t.currentFeedVisible && t.policyADecision === "PASS"
  );
  const failTrades = feed.filter(
    (t) => t.currentFeedVisible && t.policyADecision === "FAIL"
  );
  const unknownTrades = feed.filter(
    (t) => t.currentFeedVisible && t.policyADecision === "UNKNOWN"
  );

  const xPassed = xAgent.filter((r) => r.gatePassed);
  const xRemain = xPassed.filter((r) => r.policyADecision === "PASS");
  const xReject = xPassed.filter((r) => r.policyADecision === "FAIL");
  const xUnknown = xPassed.filter((r) => r.policyADecision === "UNKNOWN");

  const currentN = currentVisible.length;
  const projectedN = projectedVisible.length;

  return {
    hours,
    detectionFunnel,
    feedTrades: {
      totalInFeedHistory: feed.length,
      passesTradeGatesOnly: feed.filter(
        (t) =>
          t.passesStakeGate && t.passesTradeEvGate && t.passesTranslationGate
      ).length,
      passesProductionWalletGate: feed.filter(
        (t) => t.currentFeedVisible
      ).length,
      policyAAvailable: feed.filter((t) => t.policyAAvailable).length,
      policyAPass: feed.filter((t) => t.policyADecision === "PASS").length,
      policyAFail: feed.filter((t) => t.policyADecision === "FAIL").length,
      policyAUnknown: feed.filter((t) => t.policyADecision === "UNKNOWN")
        .length,
      currentFeedVisible: currentN,
      projectedFeedVisible: projectedN,
      absoluteReduction: currentN - projectedN,
      percentReduction:
        currentN > 0 ? ((currentN - projectedN) / currentN) * 100 : null,
      distinctProductionQualifiedWallets: productionWallets.size,
      distinctPolicyAPassWallets: policyAPassWallets.size,
      distinctWalletsBefore: productionWallets.size,
      distinctWalletsAfter: policyAPassWallets.size,
      tradesPerWhaleBefore:
        productionWallets.size > 0 ? currentN / productionWallets.size : null,
      tradesPerWhaleAfter:
        policyAPassWallets.size > 0
          ? projectedN / policyAPassWallets.size
          : null,
      volumeFromPolicyAFailWalletsPct:
        currentN > 0 ? (failVisibleTrades.length / currentN) * 100 : null,
    },
    xAgent: {
      totalCandidates: xAgent.length,
      currentlyGatePassed: xPassed.length,
      remainEligibleWithPolicyA: xRemain.length,
      rejectedByPolicyA: xReject.length,
      policyAUnknown: xUnknown.length,
    },
    quality: {
      pass: summarizeQuality(passTrades),
      fail: summarizeQuality(failTrades),
      unknown: summarizeQuality(unknownTrades),
    },
    unknownReasons,
  };
}

function topWalletConcentration(
  trades: EvaluatedFeedTrade[],
  policyAByWallet: Map<string, WalletPolicyAContext>,
  limit = 15
) {
  const visible = trades.filter((t) => t.currentFeedVisible);
  const byWallet = new Map<string, EvaluatedFeedTrade[]>();
  for (const t of visible) {
    if (!t.wallet) continue;
    const list = byWallet.get(t.wallet) ?? [];
    list.push(t);
    byWallet.set(t.wallet, list);
  }
  return [...byWallet.entries()]
    .map(([wallet, rows]) => {
      const ctx = policyAByWallet.get(wallet);
      const ev = rows.map((r) => r.tradeEvPercent);
      const stake = rows.map((r) => r.stakeUsd);
      return {
        wallet,
        tradeCount: rows.length,
        productionVerdict: ctx?.productionCredible ?? null,
        policyAVerdict: ctx?.decision ?? "UNKNOWN",
        completedPositions: ctx?.completedPositions ?? null,
        realizedRoi: ctx?.realizedRoi ?? null,
        profitablePositionRate: ctx?.profitablePositionRate ?? null,
        medianTradeEvPct: median(ev),
        totalStakeUsd: stake.reduce((s, v) => s + v, 0),
        shareOfVisibleTradesPct: visible.length > 0
          ? (rows.length / visible.length) * 100
          : 0,
      };
    })
    .sort((a, b) => b.tradeCount - a.tradeCount)
    .slice(0, limit);
}

function recommend(report72: WindowReport): string {
  const reduction = report72.feedTrades.percentReduction ?? 0;
  const unknownRate =
    report72.feedTrades.currentFeedVisible > 0
      ? (report72.quality.unknown.n / report72.feedTrades.currentFeedVisible) *
        100
      : 0;
  const whaleReduction =
    report72.feedTrades.distinctWalletsBefore > 0
      ? ((report72.feedTrades.distinctWalletsBefore -
          report72.feedTrades.distinctWalletsAfter) /
          report72.feedTrades.distinctWalletsBefore) *
        100
      : 0;
  const failVolumeShare = report72.feedTrades.volumeFromPolicyAFailWalletsPct ?? 0;

  if (unknownRate > 25) return "MORE_COVERAGE_NEEDED";
  if (reduction > 60 || whaleReduction > 50) return "TOO_AGGRESSIVE";
  if (failVolumeShare >= 40 && reduction >= 25) return "TOO_AGGRESSIVE";
  return "SAFE_FOR_LIMITED_PRODUCTION_SHADOW";
}

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const db = getDb();
  const since72 = new Date(Date.now() - 72 * 60 * 60 * 1000);

  const feedRows = await db
    .select()
    .from(feedTrades)
    .where(gte(feedTrades.tradedAt, since72))
    .orderBy(desc(feedTrades.tradedAt));

  const xLogRows = await db
    .select()
    .from(xPostLog)
    .where(gte(xPostLog.createdAt, since72))
    .orderBy(desc(xPostLog.createdAt));

  const wallets = [
    ...feedRows.map((r) => r.proxyWallet?.toLowerCase() ?? ""),
    ...xLogRows
      .map((r) => {
        const payload = r.payload as TradePayload;
        return payload.walletAddress?.toLowerCase() ?? "";
      })
      .filter(Boolean),
  ].filter(Boolean);

  const walletQualifications = await qualifyWalletsForFeed(
    [...new Set(wallets)]
  );
  const policyAByWallet = await loadWalletPolicyAContexts(wallets);

  const evaluatedFeed = feedRows.map((row) =>
    evaluateFeedTrade(row, walletQualifications, policyAByWallet)
  );

  const xAgentByTrade = new Map<
    string,
    {
      tradeId: string;
      gatePassed: boolean;
      wallet: string;
      stakeUsd: number;
      passesProductionWalletGate: boolean;
      createdAt: Date;
      policyADecision: PolicyADecision;
      policyAUnknownReason: string | null;
      policyAAvailable: boolean;
    }
  >();
  for (const row of xLogRows) {
    const payload = row.payload as TradePayload;
    if (payload.source !== "polymarket") continue;
    const wallet = payload.walletAddress?.toLowerCase();
    if (!wallet) continue;
    if (xAgentByTrade.has(row.tradeId)) continue;
    const policyA = policyAByWallet.get(wallet);
    const qualification = walletQualifications[wallet];
    const policyADecision: PolicyADecision = policyA?.decision ?? "UNKNOWN";
    xAgentByTrade.set(row.tradeId, {
      tradeId: row.tradeId,
      gatePassed: row.gatePassed,
      wallet,
      stakeUsd: payload.stakeNotional,
      passesProductionWalletGate: passesPolymarketFeedTraderGate(
        wallet,
        qualification
      ),
      createdAt: row.createdAt,
      policyADecision,
      policyAUnknownReason: policyA?.unknownReason ?? "no_indexed_history",
      policyAAvailable:
        policyADecision === "PASS" || policyADecision === "FAIL",
    });
  }
  const xAgentAll = [...xAgentByTrade.values()];

  const windowReports = WINDOWS_HOURS.map((hours) => {
    const since = Date.now() - hours * 60 * 60 * 1000;
    const xWindow = xAgentAll.filter((r) => r.createdAt.getTime() >= since);
    return buildWindowReport(hours, evaluatedFeed, xWindow);
  });

  const visible72 = evaluatedFeed.filter(
    (t) =>
      t.currentFeedVisible && t.tradedAt.getTime() >= since72.getTime()
  );
  const concentration = topWalletConcentration(visible72, policyAByWallet);

  const recommendation = recommend(windowReports[2]!);

  const report = {
    mode: "policy_a_production_impact_preview",
    readOnly: true,
    generatedAt: new Date().toISOString(),
    policyA: {
      completedPositionCountGte: 10,
      realizedRoiGt: 0,
      profitablePositionRateGte: 0.5,
      indexedDataValidityRequired: true,
      metricVersion: WALLET_METRIC_VERSION,
    },
    tradeGates: {
      minStakeUsd: MIN_PRODUCT_FEED_STAKE_USD,
      minTradeEvPct: MIN_FEED_TRADE_EV_PCT,
      translationRequired: true,
      productionWalletGateSeparate: true,
    },
    dataSources: {
      feedTrades: "feed_trades (Polymarket feed history — re-validated)",
      xAgent: "x_post_log (Polymarket X-agent pipeline audit, deduped by trade_id)",
      policyAMetrics: "wallet_historical_metrics + wallet_history_coverage",
      note:
        "Kalshi trades excluded — Policy A is wallet-historical and not applicable.",
    },
    windows: windowReports,
    concentrationTopWallets72h: concentration,
    recommendation,
    productionIntegrationPlanIfApproved: [
      "Add historicalPerformanceVerdict as shadow field in feed qualification path (lib/feedQualificationServer.ts) without changing passesPolymarketFeedTraderGate.",
      "Emit feed-visible vs policy-a-pass counts in feed_daily_metrics or shadow dashboard.",
      "Run limited production shadow: log would-filter trades for 1-2 weeks before enabling.",
      "Wire Policy A into passesPolymarketTraderCredibilityForFeed only after shadow period + sign-off.",
      "Keep trade-level stake/EV gates and X-agent stake floor independent.",
      "Do not conflate wallet avg_ev (production) with realizedRoi (indexed historical performance).",
    ],
    semantics: {
      tradeEvIsExAnte: true,
      outcomeRoiNotUsedForGating: true,
      unknownNotTreatedAsPassOrFail: true,
    },
  };

  const outDir = join(process.cwd(), "tmp/wallet-history");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(
    outDir,
    `policy-a-production-impact-${new Date().toISOString().slice(0, 10)}.json`
  );
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`\n[wrote] ${outPath}`);
}

void main().catch((error) => {
  console.error("[policy-a-production-impact-preview] failed:", error);
  process.exit(1);
});
