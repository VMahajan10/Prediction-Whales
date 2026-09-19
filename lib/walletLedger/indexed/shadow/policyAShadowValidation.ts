/**
 * Policy A shadow product validation — observational only.
 * Engineering frozen: thresholds, lifecycle, identity, and validity rules are not modified here.
 */

import { gte, sql } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/crossmarket/store/db";
import { feedTrades, xPostLog, type FeedTrade } from "@/lib/crossmarket/store/schema";
import { resolveStrictPolymarketTranslationFromPayload } from "@/lib/feed/persistedFeedTranslation";
import {
  meetsProductFeedEvThreshold,
  meetsProductFeedStakeThreshold,
  passesPolymarketFeedTraderGate,
} from "@/lib/feedQualification";
import { qualifyWalletsForFeed } from "@/lib/feedQualificationServer";
import { HISTORICAL_PERFORMANCE_POLICY_VERSION } from "@/lib/walletLedger/indexed/credibilityContractV2";
import type { HistoricalPerformanceDecision } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  buildProductionWalletCohort,
  classifyProductionWalletUnknownReason,
  type ProductionWalletCohortMember,
  type ProductionWalletUnknownReason,
} from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import { summarizeCohortCoverage } from "@/lib/walletLedger/indexed/shadow/productionWalletHydration";
import type { TradePayload } from "@/lib/x-agent/gateTypes";

export const POLICY_A_SHADOW_PERIOD_DAYS = 14;
export const POLICY_A_SHADOW_ENGINEERING_FROZEN = true;

export type ProductionGateDecision = "PASS" | "FAIL" | "UNKNOWN";
export type ShadowUnknownReportReason =
  | "unresolved_chain_order"
  | "insufficient_completed_positions"
  | "incomplete_indexed_history"
  | "no_indexed_history"
  | "hydration_pending"
  | "identity_related"
  | "other";

export type ShadowFinalRecommendation =
  | "READY_FOR_ENFORCEMENT_IMPACT_REVIEW"
  | "MORE_PRODUCTION_COVERAGE_NEEDED"
  | "POLICY_RECALIBRATION_NEEDED"
  | "SHADOW_PERIOD_IN_PROGRESS";

export interface ShadowPeriodState {
  startedAt: string;
  engineeringFrozen: true;
  observationDays: number;
  batch3Complete: true;
  baselineCohort: {
    total: number;
    pass: number;
    fail: number;
    unknown: number;
    evaluablePct: number;
    validDurableCoveragePct: number;
  };
  walletClassifications: Record<
    string,
    {
      policyA: HistoricalPerformanceDecision;
      productionGate: ProductionGateDecision;
      classifiedAt: string;
    }
  >;
}

export interface PriorityRepairEntry {
  wallet: string;
  policyAUnknownReason: ProductionWalletUnknownReason | null;
  feedVisibleTradeCount: number;
  tradeGateQualifiedTradeCount: number;
  passesProductionWalletGate: boolean;
  priorityTier: number;
  promotedAt: string;
  reason: string;
}

export interface ConfusionMatrixCell {
  productionGate: ProductionGateDecision;
  policyA: HistoricalPerformanceDecision;
  walletCount: number;
  feedVisibleTradeCount: number;
  tradeGateQualifiedTradeCount: number;
  totalStakeUsd: number;
}

export interface ForwardPerformanceBucket {
  classification: "PASS" | "FAIL";
  sampleCount: number;
  distinctWallets: number;
  medianTradeEvPct: number | null;
  medianStakeUsd: number | null;
  totalStakeUsd: number;
  tradesBelowEvFloor: number;
  badBetRateProxy: number | null;
  note: string;
}

export interface DailyShadowReport {
  mode: "policy_a_shadow_daily_report";
  generatedAt: string;
  dayKey: string;
  engineeringFrozen: true;
  shadowPeriod: {
    startedAt: string;
    daysElapsed: number;
    daysRemaining: number;
    observationComplete: boolean;
  };
  cohort: {
    totalWallets: number;
    pass: number;
    fail: number;
    unknown: number;
    evaluablePct: number;
    validDurableCoveragePct: number;
  };
  productionRelevant: {
    feedVisibleWallets: number;
    feedVisiblePolicyA: { pass: number; fail: number; unknown: number };
    productionGatePassWallets: number;
    productionGatePassPolicyA: { pass: number; fail: number; unknown: number };
    feedVisibleUnknownWallets: string[];
  };
  tradeImpact: {
    tradesPassingTradeGates: number;
    tradesCurrentlyVisible: number;
    tradesRetainedUnderPolicyA: number;
    tradesRemovedWalletFail: number;
    tradesWithheldWalletUnknown: number;
    feedVolumeReductionPct: number | null;
    stakeUsdAffected: number;
    stakeUsdRetained: number;
  };
  xAgent: {
    candidates: number;
    currentGatePassed: number;
    hypotheticalRetained: number;
    hypotheticalRemoved: number;
    hypotheticalUnknown: number;
  };
  unknownReasons: Record<ShadowUnknownReportReason, number>;
  productionGateConfusion: ConfusionMatrixCell[];
  priorityRepairQueue: PriorityRepairEntry[];
  forwardPerformance: {
    observationStart: string;
    pass: ForwardPerformanceBucket;
    fail: ForwardPerformanceBucket;
    contaminationGuard: string;
  };
  recommendation: ShadowFinalRecommendation;
  materiallyAffectedExamples: Array<{
    wallet: string;
    productionGate: ProductionGateDecision;
    policyA: HistoricalPerformanceDecision;
    feedVisibleTradeCount: number;
    tradeGateQualifiedTradeCount: number;
    impact: "removed" | "withheld" | "retained";
  }>;
}

const SHADOW_CACHE_DIR = join(process.cwd(), ".cache", "policy-a-shadow");

function isValidWalletAddress(wallet: string): boolean {
  return (
    /^0x[0-9a-f]{40}$/.test(wallet) &&
    wallet !== "0x0000000000000000000000000000000000000000"
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function pct(n: number, d: number): number {
  if (d === 0) return 0;
  return (n / d) * 100;
}

export function classifyProductionGate(input: {
  passesProductionWalletGate: boolean;
  productionHydrationState: ProductionWalletCohortMember["productionHydrationState"];
  hasIndexedMetrics: boolean;
}): ProductionGateDecision {
  if (input.productionHydrationState === "pending") return "UNKNOWN";
  if (input.productionHydrationState === "failed") return "UNKNOWN";
  if (input.productionHydrationState === "unknown" && !input.hasIndexedMetrics) {
    return "UNKNOWN";
  }
  return input.passesProductionWalletGate ? "PASS" : "FAIL";
}

export function mapUnknownReasonToReportCategory(
  reason: ProductionWalletUnknownReason | null,
  metricReasons: string[] = []
): ShadowUnknownReportReason {
  if (!reason) return "other";
  if (reason === "unresolved_chain_order") return "unresolved_chain_order";
  if (reason === "insufficient_completed_positions") {
    return "insufficient_completed_positions";
  }
  if (reason === "incomplete_indexed_history") return "incomplete_indexed_history";
  if (reason === "no_indexed_history") return "no_indexed_history";
  if (reason === "hydration_pending") return "hydration_pending";
  if (
    reason === "hydration_failed" ||
    reason === "invalid_indexed_history" ||
    metricReasons.some((r) => r.startsWith("identity_"))
  ) {
    return "identity_related";
  }
  if (reason === "missing_metrics") {
    return metricReasons.some((r) => r.startsWith("identity_"))
      ? "identity_related"
      : "other";
  }
  return "other";
}

export function buildUnknownReasonBreakdown(
  members: ProductionWalletCohortMember[],
  metricReasonsByWallet: Record<string, string[]> = {}
): Record<ShadowUnknownReportReason, number> {
  const breakdown: Record<ShadowUnknownReportReason, number> = {
    unresolved_chain_order: 0,
    insufficient_completed_positions: 0,
    incomplete_indexed_history: 0,
    no_indexed_history: 0,
    hydration_pending: 0,
    identity_related: 0,
    other: 0,
  };
  for (const member of members) {
    if (member.policyADecision !== "UNKNOWN") continue;
    const category = mapUnknownReasonToReportCategory(
      member.policyAUnknownReason,
      metricReasonsByWallet[member.wallet] ?? []
    );
    breakdown[category] += 1;
  }
  return breakdown;
}

export function buildPriorityRepairQueue(
  members: ProductionWalletCohortMember[],
  promotedAt: string
): PriorityRepairEntry[] {
  const queue: PriorityRepairEntry[] = [];
  for (const member of members) {
    if (!isValidWalletAddress(member.wallet)) continue;
    if (member.policyADecision !== "UNKNOWN") continue;
    const feedVisible = member.feedVisibleTradeCount > 0;
    const materiallyActive =
      member.tradeGateQualifiedTradeCount >= 3 && member.priorityTier <= 3;
    if (!feedVisible && !materiallyActive) continue;
    queue.push({
      wallet: member.wallet,
      policyAUnknownReason: member.policyAUnknownReason,
      feedVisibleTradeCount: member.feedVisibleTradeCount,
      tradeGateQualifiedTradeCount: member.tradeGateQualifiedTradeCount,
      passesProductionWalletGate: member.passesProductionWalletGate,
      priorityTier: member.priorityTier,
      promotedAt,
      reason: feedVisible
        ? "feed_visible_policy_a_unknown"
        : "material_trade_gate_activity_policy_a_unknown",
    });
  }
  return queue.sort(
    (a, b) =>
      a.priorityTier - b.priorityTier ||
      b.feedVisibleTradeCount - a.feedVisibleTradeCount
  );
}

export function buildProductionGateConfusionMatrix(
  members: ProductionWalletCohortMember[]
): ConfusionMatrixCell[] {
  const cells = new Map<string, ConfusionMatrixCell>();
  for (const member of members) {
    const productionGate = classifyProductionGate({
      passesProductionWalletGate: member.passesProductionWalletGate,
      productionHydrationState: member.productionHydrationState,
      hasIndexedMetrics: member.hasIndexedMetrics,
    });
    const key = `${productionGate}:${member.policyADecision}`;
    const existing = cells.get(key) ?? {
      productionGate,
      policyA: member.policyADecision,
      walletCount: 0,
      feedVisibleTradeCount: 0,
      tradeGateQualifiedTradeCount: 0,
      totalStakeUsd: 0,
    };
    existing.walletCount += 1;
    existing.feedVisibleTradeCount += member.feedVisibleTradeCount;
    existing.tradeGateQualifiedTradeCount += member.tradeGateQualifiedTradeCount;
    cells.set(key, existing);
  }
  return [...cells.values()].sort(
    (a, b) =>
      a.productionGate.localeCompare(b.productionGate) ||
      a.policyA.localeCompare(b.policyA)
  );
}

function shadowStatePath(): string {
  return join(SHADOW_CACHE_DIR, "shadow-period-state.json");
}

function priorityRepairPath(): string {
  return join(SHADOW_CACHE_DIR, "priority-repair-queue.json");
}

function dailyReportPath(dayKey: string): string {
  return join(SHADOW_CACHE_DIR, "daily-reports", `${dayKey}.json`);
}

export function loadShadowPeriodState(): ShadowPeriodState | null {
  const path = shadowStatePath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ShadowPeriodState;
}

export function initializeShadowPeriodState(
  members: ProductionWalletCohortMember[]
): ShadowPeriodState {
  const coverage = summarizeCohortCoverage(members);
  const validDurable = members.filter((m) => m.hasValidDurableCoverage).length;
  const now = new Date().toISOString();
  const state: ShadowPeriodState = {
    startedAt: now,
    engineeringFrozen: true,
    observationDays: POLICY_A_SHADOW_PERIOD_DAYS,
    batch3Complete: true,
    baselineCohort: {
      total: coverage.totalWallets,
      pass: coverage.policyAPass,
      fail: coverage.policyAFail,
      unknown: coverage.policyAUnknown,
      evaluablePct: pct(
        coverage.policyAPass + coverage.policyAFail,
        coverage.totalWallets
      ),
      validDurableCoveragePct: pct(validDurable, coverage.totalWallets),
    },
    walletClassifications: {},
  };
  for (const member of members) {
    state.walletClassifications[member.wallet] = {
      policyA: member.policyADecision,
      productionGate: classifyProductionGate({
        passesProductionWalletGate: member.passesProductionWalletGate,
        productionHydrationState: member.productionHydrationState,
        hasIndexedMetrics: member.hasIndexedMetrics,
      }),
      classifiedAt: now,
    };
  }
  mkdirSync(SHADOW_CACHE_DIR, { recursive: true });
  writeFileSync(shadowStatePath(), JSON.stringify(state, null, 2));
  return state;
}

async function loadMetricReasonsByWallet(
  wallets: string[]
): Promise<Record<string, string[]>> {
  if (wallets.length === 0) return {};
  const db = getDb();
  const rows = await db.execute<{ wallet_address: string; reasons: string[] }>(
    sql`
      SELECT wallet_address, history_incomplete_reasons AS reasons
      FROM wallet_historical_metrics
      WHERE metric_version = ${WALLET_METRIC_VERSION}
        AND wallet_address IN (${sql.join(
          wallets.map((w) => sql`${w}`),
          sql`, `
        )})
    `
  );
  const map: Record<string, string[]> = {};
  for (const row of rows.rows) {
    map[row.wallet_address.toLowerCase()] = row.reasons ?? [];
  }
  return map;
}

function evaluateFeedTradeVisibility(
  row: FeedTrade,
  qualifications: Awaited<ReturnType<typeof qualifyWalletsForFeed>>
): {
  passesTradeGates: boolean;
  currentFeedVisible: boolean;
  stakeUsd: number;
} {
  const wallet = row.proxyWallet?.trim().toLowerCase() ?? null;
  const stakeUsd = row.stakeAmount;
  const passesTradeGates =
    meetsProductFeedStakeThreshold(stakeUsd) &&
    meetsProductFeedEvThreshold(row.averageEv) &&
    resolveStrictPolymarketTranslationFromPayload(row.payload) != null;
  const qualification = wallet ? qualifications[wallet] : undefined;
  const currentFeedVisible =
    passesTradeGates &&
    passesPolymarketFeedTraderGate(wallet, qualification);
  return { passesTradeGates, currentFeedVisible, stakeUsd };
}

function buildForwardPerformanceBucket(
  classification: "PASS" | "FAIL",
  trades: Array<{
    wallet: string;
    stakeUsd: number;
    tradeEvPercent: number | null;
    tradedAt: Date;
  }>,
  frozenClassifications: ShadowPeriodState["walletClassifications"],
  observationStart: string
): ForwardPerformanceBucket {
  const startMs = new Date(observationStart).getTime();
  const filtered = trades.filter((t) => {
    const baseline = frozenClassifications[t.wallet];
    if (!baseline || baseline.policyA !== classification) return false;
    return t.tradedAt.getTime() >= startMs;
  });
  const evValues = filtered
    .map((t) => t.tradeEvPercent)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const stakeValues = filtered.map((t) => t.stakeUsd);
  const belowEv = evValues.filter((v) => v < 3).length;
  return {
    classification,
    sampleCount: filtered.length,
    distinctWallets: new Set(filtered.map((t) => t.wallet)).size,
    medianTradeEvPct: median(evValues),
    medianStakeUsd: median(stakeValues),
    totalStakeUsd: stakeValues.reduce((s, v) => s + v, 0),
    tradesBelowEvFloor: belowEv,
    badBetRateProxy:
      evValues.length > 0 ? pct(belowEv, evValues.length) : null,
    note:
      "Forward trades only (post shadow start). badBetRateProxy = share with trade EV below +3% floor; realized outcomes not yet wired.",
  };
}

export function deriveShadowRecommendation(input: {
  daysObserved: number;
  observationComplete: boolean;
  cohort: DailyShadowReport["cohort"];
  tradeImpact: DailyShadowReport["tradeImpact"];
  feedVisibleUnknownCount: number;
  priorityRepairCount: number;
}): ShadowFinalRecommendation {
  if (!input.observationComplete) return "SHADOW_PERIOD_IN_PROGRESS";
  const evaluable = input.cohort.evaluablePct;
  const unknownShare =
    input.cohort.totalWallets > 0
      ? pct(input.cohort.unknown, input.cohort.totalWallets)
      : 0;
  const reduction = input.tradeImpact.feedVolumeReductionPct ?? 0;

  if (evaluable < 50 || unknownShare > 40) {
    return "MORE_PRODUCTION_COVERAGE_NEEDED";
  }
  if (reduction > 60 || input.feedVisibleUnknownCount > 0) {
    return input.priorityRepairCount > 0
      ? "MORE_PRODUCTION_COVERAGE_NEEDED"
      : "POLICY_RECALIBRATION_NEEDED";
  }
  if (reduction > 40) return "POLICY_RECALIBRATION_NEEDED";
  return "READY_FOR_ENFORCEMENT_IMPACT_REVIEW";
}

export async function buildDailyShadowReport(input?: {
  dayKey?: string;
  lookbackDays?: number;
}): Promise<DailyShadowReport> {
  const generatedAt = new Date().toISOString();
  const dayKey = input?.dayKey ?? generatedAt.slice(0, 10);
  const lookbackDays = input?.lookbackDays ?? 30;

  const cohortReport = await buildProductionWalletCohort({ lookbackDays });
  const members = cohortReport.wallets;
  const coverage = summarizeCohortCoverage(members);
  const validDurable = members.filter((m) => m.hasValidDurableCoverage).length;

  let shadowState = loadShadowPeriodState();
  if (!shadowState) {
    shadowState = initializeShadowPeriodState(members);
    shadowState.startedAt = generatedAt;
    writeFileSync(shadowStatePath(), JSON.stringify(shadowState, null, 2));
  }

  const metricReasonsByWallet = await loadMetricReasonsByWallet(
    members.map((m) => m.wallet)
  );

  const startedAt = shadowState.startedAt;
  const daysElapsed = Math.floor(
    (Date.now() - new Date(startedAt).getTime()) / (24 * 60 * 60 * 1000)
  );
  const daysRemaining = Math.max(0, POLICY_A_SHADOW_PERIOD_DAYS - daysElapsed);
  const observationComplete = daysElapsed >= POLICY_A_SHADOW_PERIOD_DAYS;

  const feedVisibleMembers = members.filter((m) => m.feedVisibleTradeCount > 0);
  const productionPassMembers = members.filter(
    (m) => m.passesProductionWalletGate
  );

  const countPolicyA = (list: ProductionWalletCohortMember[]) => ({
    pass: list.filter((m) => m.policyADecision === "PASS").length,
    fail: list.filter((m) => m.policyADecision === "FAIL").length,
    unknown: list.filter((m) => m.policyADecision === "UNKNOWN").length,
  });

  const feedVisibleUnknownWallets = feedVisibleMembers
    .filter((m) => m.policyADecision === "UNKNOWN")
    .map((m) => m.wallet);

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const db = getDb();
  const feedRows = await db
    .select()
    .from(feedTrades)
    .where(gte(feedTrades.tradedAt, since));
  const xLogRows = await db
    .select()
    .from(xPostLog)
    .where(gte(xPostLog.createdAt, since));

  const wallets = [
    ...members.map((m) => m.wallet),
    ...feedRows.map((r) => r.proxyWallet?.toLowerCase() ?? ""),
  ].filter(Boolean);
  const qualifications = await qualifyWalletsForFeed([...new Set(wallets)]);

  const policyAByWallet = new Map(
    members.map((m) => [m.wallet, m.policyADecision])
  );

  let tradesPassingTradeGates = 0;
  let tradesCurrentlyVisible = 0;
  let tradesRetained = 0;
  let tradesRemovedFail = 0;
  let tradesWithheldUnknown = 0;
  let stakeAffected = 0;
  let stakeRetained = 0;

  const forwardTradeRows: Array<{
    wallet: string;
    stakeUsd: number;
    tradeEvPercent: number | null;
    tradedAt: Date;
  }> = [];

  for (const row of feedRows) {
    const wallet = row.proxyWallet?.trim().toLowerCase();
    if (!wallet) continue;
    const { passesTradeGates, currentFeedVisible, stakeUsd } =
      evaluateFeedTradeVisibility(row, qualifications);
    if (passesTradeGates) tradesPassingTradeGates += 1;
    if (!currentFeedVisible) continue;
    tradesCurrentlyVisible += 1;
    const policyA = policyAByWallet.get(wallet) ?? "UNKNOWN";
    forwardTradeRows.push({
      wallet,
      stakeUsd,
      tradeEvPercent: row.averageEv,
      tradedAt: row.tradedAt,
    });
    if (policyA === "PASS") {
      tradesRetained += 1;
      stakeRetained += stakeUsd;
    } else if (policyA === "FAIL") {
      tradesRemovedFail += 1;
      stakeAffected += stakeUsd;
    } else {
      tradesWithheldUnknown += 1;
      stakeAffected += stakeUsd;
    }
  }

  const xAgentByTrade = new Map<
    string,
    {
      gatePassed: boolean;
      wallet: string;
      policyA: HistoricalPerformanceDecision;
    }
  >();
  for (const row of xLogRows) {
    const payload = row.payload as TradePayload;
    if (payload.source !== "polymarket") continue;
    const wallet = payload.walletAddress?.toLowerCase();
    if (!wallet || xAgentByTrade.has(row.tradeId)) continue;
    xAgentByTrade.set(row.tradeId, {
      gatePassed: row.gatePassed,
      wallet,
      policyA: policyAByWallet.get(wallet) ?? "UNKNOWN",
    });
  }
  const xCandidates = [...xAgentByTrade.values()];
  const xPassed = xCandidates.filter((r) => r.gatePassed);

  const priorityRepairQueue = buildPriorityRepairQueue(members, generatedAt);
  mkdirSync(SHADOW_CACHE_DIR, { recursive: true });
  writeFileSync(
    priorityRepairPath(),
    JSON.stringify(
      {
        updatedAt: generatedAt,
        engineeringNote:
          "Only feed-visible or materially trade-active UNKNOWN wallets. Does not auto-trigger Batch 4.",
        queue: priorityRepairQueue,
      },
      null,
      2
    )
  );

  const materiallyAffectedExamples = members
    .filter((m) => m.feedVisibleTradeCount > 0 && m.policyADecision !== "PASS")
    .map((m) => ({
      wallet: m.wallet,
      productionGate: classifyProductionGate({
        passesProductionWalletGate: m.passesProductionWalletGate,
        productionHydrationState: m.productionHydrationState,
        hasIndexedMetrics: m.hasIndexedMetrics,
      }),
      policyA: m.policyADecision,
      feedVisibleTradeCount: m.feedVisibleTradeCount,
      tradeGateQualifiedTradeCount: m.tradeGateQualifiedTradeCount,
      impact: (m.policyADecision === "FAIL" ? "removed" : "withheld") as
        | "removed"
        | "withheld",
    }))
    .sort((a, b) => b.feedVisibleTradeCount - a.feedVisibleTradeCount)
    .slice(0, 15);

  const report: DailyShadowReport = {
    mode: "policy_a_shadow_daily_report",
    generatedAt,
    dayKey,
    engineeringFrozen: true,
    shadowPeriod: {
      startedAt,
      daysElapsed,
      daysRemaining,
      observationComplete,
    },
    cohort: {
      totalWallets: coverage.totalWallets,
      pass: coverage.policyAPass,
      fail: coverage.policyAFail,
      unknown: coverage.policyAUnknown,
      evaluablePct: pct(
        coverage.policyAPass + coverage.policyAFail,
        coverage.totalWallets
      ),
      validDurableCoveragePct: pct(validDurable, coverage.totalWallets),
    },
    productionRelevant: {
      feedVisibleWallets: feedVisibleMembers.length,
      feedVisiblePolicyA: countPolicyA(feedVisibleMembers),
      productionGatePassWallets: productionPassMembers.length,
      productionGatePassPolicyA: countPolicyA(productionPassMembers),
      feedVisibleUnknownWallets,
    },
    tradeImpact: {
      tradesPassingTradeGates,
      tradesCurrentlyVisible,
      tradesRetainedUnderPolicyA: tradesRetained,
      tradesRemovedWalletFail: tradesRemovedFail,
      tradesWithheldWalletUnknown: tradesWithheldUnknown,
      feedVolumeReductionPct:
        tradesCurrentlyVisible > 0
          ? pct(
              tradesRemovedFail + tradesWithheldUnknown,
              tradesCurrentlyVisible
            )
          : null,
      stakeUsdAffected: stakeAffected,
      stakeUsdRetained: stakeRetained,
    },
    xAgent: {
      candidates: xCandidates.length,
      currentGatePassed: xPassed.length,
      hypotheticalRetained: xPassed.filter((r) => r.policyA === "PASS").length,
      hypotheticalRemoved: xPassed.filter((r) => r.policyA === "FAIL").length,
      hypotheticalUnknown: xPassed.filter((r) => r.policyA === "UNKNOWN").length,
    },
    unknownReasons: buildUnknownReasonBreakdown(members, metricReasonsByWallet),
    productionGateConfusion: buildProductionGateConfusionMatrix(members),
    priorityRepairQueue,
    forwardPerformance: {
      observationStart: startedAt,
      pass: buildForwardPerformanceBucket(
        "PASS",
        forwardTradeRows,
        shadowState.walletClassifications,
        startedAt
      ),
      fail: buildForwardPerformanceBucket(
        "FAIL",
        forwardTradeRows,
        shadowState.walletClassifications,
        startedAt
      ),
      contaminationGuard:
        "Uses frozen wallet classifications from shadow period start; forward trades only.",
    },
    recommendation: deriveShadowRecommendation({
      daysObserved: daysElapsed + 1,
      observationComplete,
      cohort: {
        totalWallets: coverage.totalWallets,
        pass: coverage.policyAPass,
        fail: coverage.policyAFail,
        unknown: coverage.policyAUnknown,
        evaluablePct: pct(
          coverage.policyAPass + coverage.policyAFail,
          coverage.totalWallets
        ),
        validDurableCoveragePct: pct(validDurable, coverage.totalWallets),
      },
      tradeImpact: {
        tradesPassingTradeGates,
        tradesCurrentlyVisible,
        tradesRetainedUnderPolicyA: tradesRetained,
        tradesRemovedWalletFail: tradesRemovedFail,
        tradesWithheldWalletUnknown: tradesWithheldUnknown,
        feedVolumeReductionPct:
          tradesCurrentlyVisible > 0
            ? pct(
                tradesRemovedFail + tradesWithheldUnknown,
                tradesCurrentlyVisible
              )
            : null,
        stakeUsdAffected: stakeAffected,
        stakeUsdRetained: stakeRetained,
      },
      feedVisibleUnknownCount: feedVisibleUnknownWallets.length,
      priorityRepairCount: priorityRepairQueue.length,
    }),
    materiallyAffectedExamples,
  };

  mkdirSync(join(SHADOW_CACHE_DIR, "daily-reports"), { recursive: true });
  writeFileSync(dailyReportPath(dayKey), JSON.stringify(report, null, 2));

  return report;
}

export async function buildShadowPeriodSummary(): Promise<{
  policyVersion: string;
  metricVersion: string;
  engineeringFrozen: boolean;
  dailyReports: string[];
  latestReport: DailyShadowReport | null;
  trajectory: Array<{
    dayKey: string;
    evaluablePct: number;
    validDurableCoveragePct: number;
    feedVolumeReductionPct: number | null;
    recommendation: ShadowFinalRecommendation;
  }>;
}> {
  const reportsDir = join(SHADOW_CACHE_DIR, "daily-reports");
  if (!existsSync(reportsDir)) {
    return {
      policyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
      metricVersion: WALLET_METRIC_VERSION,
      engineeringFrozen: POLICY_A_SHADOW_ENGINEERING_FROZEN,
      dailyReports: [],
      latestReport: null,
      trajectory: [],
    };
  }
  const { readdirSync } = await import("node:fs");
  const dailyReports = readdirSync(reportsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const trajectory = dailyReports.map((file) => {
    const report = JSON.parse(
      readFileSync(join(reportsDir, file), "utf8")
    ) as DailyShadowReport;
    return {
      dayKey: report.dayKey,
      evaluablePct: report.cohort.evaluablePct,
      validDurableCoveragePct: report.cohort.validDurableCoveragePct,
      feedVolumeReductionPct: report.tradeImpact.feedVolumeReductionPct,
      recommendation: report.recommendation,
    };
  });
  const latestReport =
    dailyReports.length > 0
      ? (JSON.parse(
          readFileSync(join(reportsDir, dailyReports.at(-1)!), "utf8")
        ) as DailyShadowReport)
      : null;
  return {
    policyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
    metricVersion: WALLET_METRIC_VERSION,
    engineeringFrozen: POLICY_A_SHADOW_ENGINEERING_FROZEN,
    dailyReports,
    latestReport,
    trajectory,
  };
}
