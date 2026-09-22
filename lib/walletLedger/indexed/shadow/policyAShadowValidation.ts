/**
 * Policy A shadow product validation — observational only.
 * Engineering frozen: thresholds, lifecycle, identity, and validity rules are not modified here.
 */

import { gte, sql } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  feedTrades,
  policyAShadowTradeObservations,
  xPostLog,
  type FeedTrade,
} from "@/lib/crossmarket/store/schema";
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
/** Feed trader attribution resolver generation (shadow comparability). */
export const POLICY_A_ATTRIBUTION_RESOLVER_VERSION = "economic-order-filled-v1";

export type ProductionGateDecision = "PASS" | "FAIL" | "UNKNOWN";
export type ShadowUnknownReportReason =
  | "unresolved_chain_order"
  | "identity_related"
  | "insufficient_completed_positions"
  | "incomplete_indexed_history"
  | "no_indexed_history"
  | "hydration_pending"
  | "hydration_failed"
  | "other";

/** Policy A completed-positions floor — reporting reference only. */
export const POLICY_A_COMPLETED_POSITIONS_FLOOR = 10;

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
  /** When set, shadow feed-impact metrics are comparable only within this resolver generation. */
  attributionResolverVersion?: string;
  supersededObservation?: {
    startedAt: string;
    endedAt: string;
    reason: string;
    comparability: "pre-resolver-fix-non-comparable";
    priorAttributionResolverVersion?: string | null;
  };
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
  policyAUnknownReason: ShadowUnknownReportReason;
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

export interface ForwardPerformanceDiagnostics {
  observationStart: string;
  shadowObservationRowsSinceStart: number;
  feedVisibleTradesSinceStart: number;
  expectedQualifyingPass: number;
  expectedQualifyingFail: number;
  actualQualifyingPass: number;
  actualQualifyingFail: number;
  exclusions: {
    beforeObservationStart: number;
    missingTimestamp: number;
    walletNotInFrozenBaseline: number;
    frozenPolicyAUnknown: number;
    frozenPolicyAOther: number;
    duplicateTradeIdsCollapsed: number;
  };
  dataSources: {
    shadowObservations: number;
    feedTrades: number;
  };
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
    attributionResolverVersion: string | null;
    feedImpactComparable: boolean;
    supersededObservation?: ShadowPeriodState["supersededObservation"];
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
    diagnostics: ForwardPerformanceDiagnostics;
  };
  liveShadowWrites?: {
    latestObservationAt: string | null;
    observationsSinceShadowStart: number;
    distinctWalletsSinceShadowStart: number;
    distinctTradesSinceShadowStart: number;
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

function hasIdentityMetricSignals(metricReasons: string[]): boolean {
  return metricReasons.some(
    (reason) =>
      reason.startsWith("identity_") ||
      reason === "positions_without_history_events"
  );
}

function isTrustworthyLowSampleTerminalUnknown(
  member: ProductionWalletCohortMember
): boolean {
  return (
    member.hasValidDurableCoverage &&
    member.historyValidity === "partial-but-metrics-safe" &&
    (member.completedPositions ?? 0) < POLICY_A_COMPLETED_POSITIONS_FLOOR
  );
}

/**
 * Shadow-report UNKNOWN reason with explicit terminal-trust precedence.
 * Reporting only — does not alter Policy A eligibility or hydration.
 *
 * Precedence:
 * 1. unresolved_chain_order
 * 2. identity_related
 * 3. insufficient_completed_positions
 * 4. incomplete_indexed_history
 * 5. no_indexed_history
 * 6. hydration_pending
 * 7. hydration_failed
 * 8. other
 */
export function classifyShadowUnknownReportReason(
  member: ProductionWalletCohortMember,
  metricReasons: string[] = []
): ShadowUnknownReportReason {
  const raw = member.policyAUnknownReason;

  if (
    raw === "unresolved_chain_order" ||
    metricReasons.includes("unresolved_chain_order")
  ) {
    return "unresolved_chain_order";
  }

  if (raw === "invalid_indexed_history" || hasIdentityMetricSignals(metricReasons)) {
    return "identity_related";
  }

  if (
    raw === "insufficient_completed_positions" ||
    isTrustworthyLowSampleTerminalUnknown(member)
  ) {
    return "insufficient_completed_positions";
  }

  if (raw === "incomplete_indexed_history") {
    return "incomplete_indexed_history";
  }

  if (
    raw === "no_indexed_history" ||
    (raw === "missing_metrics" && !member.hasIndexedMetrics)
  ) {
    return "no_indexed_history";
  }
  if (!member.hasIndexedMetrics && !member.hasIndexedCoverage) {
    return "no_indexed_history";
  }

  if (raw === "hydration_pending" || member.productionHydrationState === "pending") {
    return "hydration_pending";
  }

  if (raw === "hydration_failed" || member.productionHydrationState === "failed") {
    return "hydration_failed";
  }

  return "other";
}

/** @deprecated Prefer classifyShadowUnknownReportReason with full member context. */
export function mapUnknownReasonToReportCategory(
  reason: ProductionWalletUnknownReason | null,
  metricReasons: string[] = []
): ShadowUnknownReportReason {
  return classifyShadowUnknownReportReason(
    {
      wallet: "",
      priorityTier: 4,
      inFeedTrades: false,
      feedVisibleTradeCount: 0,
      inXPostLog: false,
      xPostLogTradeCount: 0,
      passesProductionWalletGate: false,
      tradeGateQualifiedTradeCount: 0,
      productionHydrationState: "unknown",
      hasIndexedCoverage: false,
      hasIndexedMetrics: false,
      indexedDataValidity: false,
      policyADecision: "UNKNOWN",
      policyAUnknownReason: reason,
      completedPositions: null,
      realizedRoi: null,
      profitablePositionRate: null,
      historyValidity: null,
      historyComplete: null,
      hasValidDurableCoverage: false,
    },
    metricReasons
  );
}

export function buildUnknownReasonBreakdown(
  members: ProductionWalletCohortMember[],
  metricReasonsByWallet: Record<string, string[]> = {}
): Record<ShadowUnknownReportReason, number> {
  const breakdown: Record<ShadowUnknownReportReason, number> = {
    unresolved_chain_order: 0,
    identity_related: 0,
    insufficient_completed_positions: 0,
    incomplete_indexed_history: 0,
    no_indexed_history: 0,
    hydration_pending: 0,
    hydration_failed: 0,
    other: 0,
  };
  for (const member of members) {
    if (member.policyADecision !== "UNKNOWN") continue;
    const category = classifyShadowUnknownReportReason(
      member,
      metricReasonsByWallet[member.wallet] ?? []
    );
    breakdown[category] += 1;
  }
  return breakdown;
}

export interface PriorityRepairAttributionEpochScope {
  /** Current resolver-attribution epoch start (shadow period startedAt). */
  attributionEpochStartAt: string;
  feedRows: FeedTrade[];
  qualifications: Awaited<ReturnType<typeof qualifyWalletsForFeed>>;
}

/** Trade counts limited to feed rows at/after the attribution epoch boundary. */
export function buildWalletAttributionEpochTradeCounts(
  scope: PriorityRepairAttributionEpochScope
): Map<
  string,
  { feedVisibleTradeCount: number; tradeGateQualifiedTradeCount: number }
> {
  const startMs = new Date(scope.attributionEpochStartAt).getTime();
  const counts = new Map<
    string,
    { feedVisibleTradeCount: number; tradeGateQualifiedTradeCount: number }
  >();

  for (const row of scope.feedRows) {
    if (row.tradedAt.getTime() < startMs) continue;
    const wallet = row.proxyWallet?.trim().toLowerCase();
    if (!wallet) continue;
    const { passesTradeGates, currentFeedVisible } = evaluateFeedTradeVisibility(
      row,
      scope.qualifications
    );
    const entry = counts.get(wallet) ?? {
      feedVisibleTradeCount: 0,
      tradeGateQualifiedTradeCount: 0,
    };
    if (passesTradeGates) {
      entry.tradeGateQualifiedTradeCount += 1;
    }
    if (currentFeedVisible) {
      entry.feedVisibleTradeCount += 1;
    }
    counts.set(wallet, entry);
  }

  return counts;
}

export function buildPriorityRepairQueue(
  members: ProductionWalletCohortMember[],
  promotedAt: string,
  metricReasonsByWallet: Record<string, string[]> = {},
  attributionEpochScope?: PriorityRepairAttributionEpochScope
): PriorityRepairEntry[] {
  const epochCounts = attributionEpochScope
    ? buildWalletAttributionEpochTradeCounts(attributionEpochScope)
    : null;

  const queue: PriorityRepairEntry[] = [];
  for (const member of members) {
    if (!isValidWalletAddress(member.wallet)) continue;
    if (member.policyADecision !== "UNKNOWN") continue;

    const scoped = epochCounts?.get(member.wallet);
    const feedVisibleTradeCount = epochCounts
      ? (scoped?.feedVisibleTradeCount ?? 0)
      : member.feedVisibleTradeCount;
    const tradeGateQualifiedTradeCount = epochCounts
      ? (scoped?.tradeGateQualifiedTradeCount ?? 0)
      : member.tradeGateQualifiedTradeCount;

    const feedVisible = feedVisibleTradeCount > 0;
    const materiallyActive =
      tradeGateQualifiedTradeCount >= 3 && member.priorityTier <= 3;
    if (!feedVisible && !materiallyActive) continue;
    queue.push({
      wallet: member.wallet,
      policyAUnknownReason: classifyShadowUnknownReportReason(
        member,
        metricReasonsByWallet[member.wallet] ?? []
      ),
      feedVisibleTradeCount,
      tradeGateQualifiedTradeCount,
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

export function buildWalletFeedVisibleStakeMap(
  feedRows: FeedTrade[],
  qualifications: Awaited<ReturnType<typeof qualifyWalletsForFeed>>
): Map<string, number> {
  const stakeByWallet = new Map<string, number>();
  for (const row of feedRows) {
    const wallet = row.proxyWallet?.trim().toLowerCase();
    if (!wallet) continue;
    const { currentFeedVisible, stakeUsd } = evaluateFeedTradeVisibility(
      row,
      qualifications
    );
    if (!currentFeedVisible) continue;
    stakeByWallet.set(wallet, (stakeByWallet.get(wallet) ?? 0) + stakeUsd);
  }
  return stakeByWallet;
}

export function buildProductionGateConfusionMatrix(
  members: ProductionWalletCohortMember[],
  walletFeedVisibleStakeUsd: Map<string, number> = new Map()
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
    existing.totalStakeUsd += walletFeedVisibleStakeUsd.get(member.wallet) ?? 0;
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
    attributionResolverVersion: POLICY_A_ATTRIBUTION_RESOLVER_VERSION,
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

/**
 * Archive the current shadow window (pre-resolver-fix) and start a fresh epoch.
 * Does not modify feed_trades — run d91-resolver-replay plan separately.
 */
export function beginPostResolverFixShadowEpoch(
  members: ProductionWalletCohortMember[]
): ShadowPeriodState {
  const prior = loadShadowPeriodState();
  const next = initializeShadowPeriodState(members);
  if (prior) {
    next.supersededObservation = {
      startedAt: prior.startedAt,
      endedAt: new Date().toISOString(),
      reason: "wallet_attribution_resolver_economic_order_filled_v1",
      comparability: "pre-resolver-fix-non-comparable",
      priorAttributionResolverVersion: prior.attributionResolverVersion ?? null,
    };
    writeFileSync(shadowStatePath(), JSON.stringify(next, null, 2));
  }
  return next;
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

interface ForwardPerformanceTrade {
  tradeId: string;
  wallet: string;
  stakeUsd: number;
  tradeEvPercent: number | null;
  tradedAt: Date;
  source: "shadow_observation" | "feed_trade";
}

function buildForwardPerformanceBucket(
  classification: "PASS" | "FAIL",
  trades: ForwardPerformanceTrade[],
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
      "Post-shadow-start trade-gate-qualified trades for frozen PASS/FAIL wallets. Uses shadow observations when available; no realized outcomes required.",
  };
}

async function loadForwardPerformanceTrades(input: {
  observationStart: string;
  feedRows: FeedTrade[];
  qualifications: Awaited<ReturnType<typeof qualifyWalletsForFeed>>;
}): Promise<ForwardPerformanceTrade[]> {
  const startMs = new Date(input.observationStart).getTime();
  const byTradeId = new Map<string, ForwardPerformanceTrade>();

  const db = getDb();
  const observationRows = await db
    .select()
    .from(policyAShadowTradeObservations)
    .where(
      gte(
        policyAShadowTradeObservations.observedAt,
        new Date(input.observationStart)
      )
    );

  for (const row of observationRows) {
    const wallet = row.walletAddress.toLowerCase();
    const tradedAt = row.tradedAt ?? row.observedAt;
    if (!tradedAt) continue;
    const tradeKey = `${row.source}:${row.tradeId}`;
    byTradeId.set(tradeKey, {
      tradeId: row.tradeId,
      wallet,
      stakeUsd: row.stakeUsd ?? 0,
      tradeEvPercent: row.tradeEvPercent,
      tradedAt,
      source: "shadow_observation",
    });
  }

  for (const row of input.feedRows) {
    const wallet = row.proxyWallet?.trim().toLowerCase();
    if (!wallet) continue;
    const { passesTradeGates } = evaluateFeedTradeVisibility(
      row,
      input.qualifications
    );
    if (!passesTradeGates) continue;
    if (row.tradedAt.getTime() < startMs) continue;
    const tradeKey = `feed_trade:${row.tradeId}`;
    if (byTradeId.has(tradeKey)) continue;
    byTradeId.set(tradeKey, {
      tradeId: row.tradeId,
      wallet,
      stakeUsd: row.stakeAmount,
      tradeEvPercent: row.averageEv,
      tradedAt: row.tradedAt,
      source: "feed_trade",
    });
  }

  return [...byTradeId.values()];
}

export function analyzeForwardPerformanceExclusions(input: {
  observationStart: string;
  trades: ForwardPerformanceTrade[];
  frozenClassifications: ShadowPeriodState["walletClassifications"];
}): ForwardPerformanceDiagnostics {
  const startMs = new Date(input.observationStart).getTime();
  const exclusions = {
    beforeObservationStart: 0,
    missingTimestamp: 0,
    walletNotInFrozenBaseline: 0,
    frozenPolicyAUnknown: 0,
    frozenPolicyAOther: 0,
    duplicateTradeIdsCollapsed: 0,
  };

  let expectedQualifyingPass = 0;
  let expectedQualifyingFail = 0;
  let actualQualifyingPass = 0;
  let actualQualifyingFail = 0;

  const shadowRows = input.trades.filter(
    (t) => t.source === "shadow_observation"
  ).length;
  const feedRows = input.trades.filter((t) => t.source === "feed_trade").length;

  for (const trade of input.trades) {
    if (!trade.tradedAt) {
      exclusions.missingTimestamp += 1;
      continue;
    }
    if (trade.tradedAt.getTime() < startMs) {
      exclusions.beforeObservationStart += 1;
      continue;
    }
    const baseline = input.frozenClassifications[trade.wallet];
    if (!baseline) {
      exclusions.walletNotInFrozenBaseline += 1;
      continue;
    }
    if (baseline.policyA === "UNKNOWN") {
      exclusions.frozenPolicyAUnknown += 1;
      continue;
    }
    if (baseline.policyA !== "PASS" && baseline.policyA !== "FAIL") {
      exclusions.frozenPolicyAOther += 1;
      continue;
    }
    if (baseline.policyA === "PASS") {
      expectedQualifyingPass += 1;
      actualQualifyingPass += 1;
    } else {
      expectedQualifyingFail += 1;
      actualQualifyingFail += 1;
    }
  }

  const feedVisibleSinceStart = input.trades.filter(
    (t) => t.tradedAt.getTime() >= startMs
  ).length;

  return {
    observationStart: input.observationStart,
    shadowObservationRowsSinceStart: shadowRows,
    feedVisibleTradesSinceStart: feedVisibleSinceStart,
    expectedQualifyingPass,
    expectedQualifyingFail,
    actualQualifyingPass,
    actualQualifyingFail,
    exclusions,
    dataSources: {
      shadowObservations: shadowRows,
      feedTrades: feedRows,
    },
  };
}

export async function diagnoseForwardPerformance(): Promise<ForwardPerformanceDiagnostics> {
  const shadowState = loadShadowPeriodState();
  const observationStart =
    shadowState?.startedAt ?? new Date().toISOString();
  const lookbackDays = 30;
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const db = getDb();
  const feedRows = await db
    .select()
    .from(feedTrades)
    .where(gte(feedTrades.tradedAt, since));
  const wallets = feedRows
    .map((r) => r.proxyWallet?.toLowerCase() ?? "")
    .filter(Boolean);
  const qualifications = await qualifyWalletsForFeed([...new Set(wallets)]);
  const trades = await loadForwardPerformanceTrades({
    observationStart,
    feedRows,
    qualifications,
  });
  return analyzeForwardPerformanceExclusions({
    observationStart,
    trades,
    frozenClassifications: shadowState?.walletClassifications ?? {},
  });
}

async function loadLiveShadowWriteStats(
  observationStart: string
): Promise<DailyShadowReport["liveShadowWrites"]> {
  const db = getDb();
  const since = new Date(observationStart);
  const [stats] = await db
    .select({
      count: sql<number>`count(*)::int`,
      distinctWallets: sql<number>`count(distinct ${policyAShadowTradeObservations.walletAddress})::int`,
      distinctTrades: sql<number>`count(distinct ${policyAShadowTradeObservations.tradeId})::int`,
      latestAt: sql<string | null>`max(${policyAShadowTradeObservations.observedAt})`,
    })
    .from(policyAShadowTradeObservations)
    .where(gte(policyAShadowTradeObservations.observedAt, since));

  return {
    latestObservationAt: stats?.latestAt ?? null,
    observationsSinceShadowStart: stats?.count ?? 0,
    distinctWalletsSinceShadowStart: stats?.distinctWallets ?? 0,
    distinctTradesSinceShadowStart: stats?.distinctTrades ?? 0,
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

  const walletFeedVisibleStakeUsd = buildWalletFeedVisibleStakeMap(
    feedRows,
    qualifications
  );

  for (const row of feedRows) {
    const wallet = row.proxyWallet?.trim().toLowerCase();
    if (!wallet) continue;
    const { passesTradeGates, currentFeedVisible, stakeUsd } =
      evaluateFeedTradeVisibility(row, qualifications);
    if (passesTradeGates) tradesPassingTradeGates += 1;
    if (!currentFeedVisible) continue;
    tradesCurrentlyVisible += 1;
    const policyA = policyAByWallet.get(wallet) ?? "UNKNOWN";
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

  const forwardPerformanceTrades = await loadForwardPerformanceTrades({
    observationStart: startedAt,
    feedRows,
    qualifications,
  });
  const forwardPerformanceDiagnostics = analyzeForwardPerformanceExclusions({
    observationStart: startedAt,
    trades: forwardPerformanceTrades,
    frozenClassifications: shadowState.walletClassifications,
  });
  const liveShadowWrites = await loadLiveShadowWriteStats(startedAt);

  const priorityRepairQueue = buildPriorityRepairQueue(
    members,
    generatedAt,
    metricReasonsByWallet,
    shadowState.attributionResolverVersion
      ? {
          attributionEpochStartAt: startedAt,
          feedRows,
          qualifications,
        }
      : undefined
  );
  mkdirSync(SHADOW_CACHE_DIR, { recursive: true });
  writeFileSync(
    priorityRepairPath(),
    JSON.stringify(
      {
        updatedAt: generatedAt,
        engineeringNote:
          "Only feed-visible or materially trade-active UNKNOWN wallets in the current attribution-resolver epoch. Does not auto-trigger Batch 4.",
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
      attributionResolverVersion:
        shadowState.attributionResolverVersion ?? null,
      feedImpactComparable:
        shadowState.attributionResolverVersion ===
        POLICY_A_ATTRIBUTION_RESOLVER_VERSION,
      supersededObservation: shadowState.supersededObservation,
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
    productionGateConfusion: buildProductionGateConfusionMatrix(
      members,
      walletFeedVisibleStakeUsd
    ),
    priorityRepairQueue,
    liveShadowWrites,
    forwardPerformance: {
      observationStart: startedAt,
      pass: buildForwardPerformanceBucket(
        "PASS",
        forwardPerformanceTrades,
        shadowState.walletClassifications,
        startedAt
      ),
      fail: buildForwardPerformanceBucket(
        "FAIL",
        forwardPerformanceTrades,
        shadowState.walletClassifications,
        startedAt
      ),
      contaminationGuard:
        "Uses frozen wallet classifications from shadow period start; post-start trade-gate-qualified trades only.",
      diagnostics: forwardPerformanceDiagnostics,
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

export type ShadowTrajectoryPoint = {
  dayKey: string;
  generatedAt: string;
  evaluablePct: number;
  validDurableCoveragePct: number;
  feedVolumeReductionPct: number | null;
  recommendation: ShadowFinalRecommendation;
  shadowPeriodStartedAt: string;
  attributionResolverVersion: string | null;
};

export type SupersededShadowEpochSummary = {
  shadowPeriodStartedAt: string;
  shadowPeriodEndedAt: string | null;
  attributionResolverVersion: string | null;
  comparability: "pre-resolver-fix-non-comparable" | "superseded-epoch";
  trajectory: ShadowTrajectoryPoint[];
};

export function shadowTrajectoryPointFromReport(
  report: DailyShadowReport
): ShadowTrajectoryPoint {
  return {
    dayKey: report.dayKey,
    generatedAt: report.generatedAt,
    evaluablePct: report.cohort.evaluablePct,
    validDurableCoveragePct: report.cohort.validDurableCoveragePct,
    feedVolumeReductionPct: report.tradeImpact.feedVolumeReductionPct,
    recommendation: report.recommendation,
    shadowPeriodStartedAt: report.shadowPeriod.startedAt,
    attributionResolverVersion:
      report.shadowPeriod.attributionResolverVersion ?? null,
  };
}

export function isCurrentAttributionEpochReport(
  report: DailyShadowReport,
  shadowState: ShadowPeriodState | null
): boolean {
  if (!shadowState) return true;
  if (report.shadowPeriod.startedAt !== shadowState.startedAt) return false;
  if (
    shadowState.attributionResolverVersion &&
    report.shadowPeriod.attributionResolverVersion !==
      shadowState.attributionResolverVersion
  ) {
    return false;
  }
  return true;
}

export function splitShadowTrajectoryByAttributionEpoch(
  reports: DailyShadowReport[],
  shadowState: ShadowPeriodState | null
): {
  currentEpochTrajectory: ShadowTrajectoryPoint[];
  supersededEpochs: SupersededShadowEpochSummary[];
  /** Primary comparable trajectory (current attribution epoch only). */
  trajectory: ShadowTrajectoryPoint[];
} {
  const currentEpochTrajectory = reports
    .filter((r) => isCurrentAttributionEpochReport(r, shadowState))
    .map(shadowTrajectoryPointFromReport);

  const supersededByStartedAt = new Map<string, ShadowTrajectoryPoint[]>();
  for (const report of reports) {
    if (isCurrentAttributionEpochReport(report, shadowState)) continue;
    const point = shadowTrajectoryPointFromReport(report);
    const key = point.shadowPeriodStartedAt;
    const list = supersededByStartedAt.get(key) ?? [];
    list.push(point);
    supersededByStartedAt.set(key, list);
  }

  const supersededEpochs: SupersededShadowEpochSummary[] = [
    ...supersededByStartedAt.entries(),
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([shadowPeriodStartedAt, trajectory]) => {
      const sorted = [...trajectory].sort((a, b) =>
        a.dayKey.localeCompare(b.dayKey)
      );
      const last = sorted.at(-1);
      const fromState =
        shadowState?.supersededObservation?.startedAt === shadowPeriodStartedAt
          ? shadowState.supersededObservation
          : null;
      const comparability =
        fromState?.comparability === "pre-resolver-fix-non-comparable"
          ? "pre-resolver-fix-non-comparable"
          : "superseded-epoch";
      return {
        shadowPeriodStartedAt,
        shadowPeriodEndedAt:
          fromState?.endedAt ?? last?.generatedAt ?? null,
        attributionResolverVersion:
          fromState?.priorAttributionResolverVersion ??
          sorted[0]?.attributionResolverVersion ??
          null,
        comparability,
        trajectory: sorted,
      };
    });

  return {
    currentEpochTrajectory,
    supersededEpochs,
    trajectory: currentEpochTrajectory,
  };
}

export async function buildShadowPeriodSummary(): Promise<{
  policyVersion: string;
  metricVersion: string;
  engineeringFrozen: boolean;
  dailyReports: string[];
  latestReport: DailyShadowReport | null;
  attributionResolverVersion: string | null;
  currentEpochStartedAt: string | null;
  trajectory: ShadowTrajectoryPoint[];
  currentEpochTrajectory: ShadowTrajectoryPoint[];
  supersededEpochs: SupersededShadowEpochSummary[];
  supersededObservation: ShadowPeriodState["supersededObservation"] | null;
}> {
  const shadowState = loadShadowPeriodState();
  const reportsDir = join(SHADOW_CACHE_DIR, "daily-reports");
  if (!existsSync(reportsDir)) {
    return {
      policyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
      metricVersion: WALLET_METRIC_VERSION,
      engineeringFrozen: POLICY_A_SHADOW_ENGINEERING_FROZEN,
      dailyReports: [],
      latestReport: null,
      attributionResolverVersion: shadowState?.attributionResolverVersion ?? null,
      currentEpochStartedAt: shadowState?.startedAt ?? null,
      trajectory: [],
      currentEpochTrajectory: [],
      supersededEpochs: [],
      supersededObservation: shadowState?.supersededObservation ?? null,
    };
  }
  const { readdirSync } = await import("node:fs");
  const dailyReportFiles = readdirSync(reportsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const parsedReports = dailyReportFiles.map(
    (file) =>
      JSON.parse(readFileSync(join(reportsDir, file), "utf8")) as DailyShadowReport
  );
  const split = splitShadowTrajectoryByAttributionEpoch(
    parsedReports,
    shadowState
  );
  const latestReport =
    parsedReports.length > 0 ? parsedReports.at(-1)! : null;
  return {
    policyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
    metricVersion: WALLET_METRIC_VERSION,
    engineeringFrozen: POLICY_A_SHADOW_ENGINEERING_FROZEN,
    dailyReports: dailyReportFiles,
    latestReport,
    attributionResolverVersion: shadowState?.attributionResolverVersion ?? null,
    currentEpochStartedAt: shadowState?.startedAt ?? null,
    trajectory: split.trajectory,
    currentEpochTrajectory: split.currentEpochTrajectory,
    supersededEpochs: split.supersededEpochs,
    supersededObservation: shadowState?.supersededObservation ?? null,
  };
}
