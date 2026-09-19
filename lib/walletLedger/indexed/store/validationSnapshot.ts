import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sortLedgerEventsCanonical } from "@/lib/walletLedger/eventOrder";
import { GammaResolutionCache, buildMarketResolveHints } from "@/lib/walletLedger/gamma";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  filterChainAuthoritativeEvents,
  hashAuthoritativeEventIdentities,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import {
  hashLifecycleInputLegacy,
  hashLifecycleInputSequence,
} from "@/lib/walletLedger/indexed/store/lifecycleInputHash";
import { backfillAuthoritativeLogIndexFromLookup } from "@/lib/walletLedger/indexed/store/logIndexTaxonomy";
import { assessUnresolvedChainOrder } from "@/lib/walletLedger/indexed/store/unresolvedChainOrder";
import type { IndexedAuditWalletResult } from "@/lib/walletLedger/indexed/types";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import { mergeApiAndChainEvents } from "@/lib/walletLedger/onchain/normalize";
import type {
  GammaMarketResolution,
  PositionLifecycle,
  WalletLedgerEvent,
} from "@/lib/walletLedger/types";

export interface WalletValidationSnapshotMetrics {
  completedPositions: number;
  realizedRoi: number;
  profitablePositionRate: number;
  historyValidity: string;
  credibilityMetricsValid: boolean;
  policyAVerdict: string;
  lifecycleEpisodeCount: number;
}

export interface WalletValidationSnapshot {
  wallet: string;
  runId: string;
  runTimestamp: string;
  metricVersion: string;
  chainId: string;
  scanFromBlock: number | null;
  throughBlock: number | null;
  apiEvents: WalletLedgerEvent[];
  authoritativeEvents: WalletLedgerEvent[];
  authoritativeEventCount: number;
  authoritativeEventIdentityHash: string;
  combinedEventCount: number;
  replayInputHash: string;
  /** Hash of the exact inputs used during audit metric computation. */
  metricComputationInputHash: string;
  /** @deprecated Legacy dedupe-key-oriented hash; use auditLifecycleInputSequenceHash. */
  auditLifecycleInputHash: string;
  auditLifecycleInputCount: number;
  /** Exact ordered lifecycle sequence hash (canonical identity + multiplicity). */
  auditLifecycleInputSequenceHash: string;
  auditLifecycleInputEventCount: number;
  oldestActivityTimestamp: number | null;
  oldestTradesTimestamp: number | null;
  activityTruncated: boolean;
  tradesTruncated: boolean;
  gammaCacheEntries: Array<[string, GammaMarketResolution]>;
  auditMetrics: WalletValidationSnapshotMetrics;
  lifecycleEpisodeKeys: string[];
}

export interface WalletValidationReplayResult {
  metrics: WalletValidationSnapshotMetrics;
  positions: PositionLifecycle[];
  combinedEventCount: number;
}

const SNAPSHOT_ROOT = path.join(
  process.cwd(),
  ".cache",
  "wallet-validation-snapshots"
);

export function lifecycleEpisodeKey(position: PositionLifecycle): string {
  return [
    position.conditionId,
    position.asset,
    position.completed ? "1" : "0",
    position.completionReason ?? "",
    position.firstEntryAt ?? "",
    position.lastActivityAt ?? "",
  ].join("|");
}

export function hashReplayInput(input: {
  apiEvents: WalletLedgerEvent[];
  authoritativeEvents: WalletLedgerEvent[];
  activityTruncated: boolean;
  tradesTruncated: boolean;
  gammaCacheEntries: Array<[string, GammaMarketResolution]>;
}): string {
  const apiKeys = input.apiEvents.map((event) => event.dedupeKey).sort();
  const authHash = hashAuthoritativeEventIdentities(input.authoritativeEvents);
  return createHash("sha256")
    .update(
      JSON.stringify({
        apiKeys,
        authHash,
        activityTruncated: input.activityTruncated,
        tradesTruncated: input.tradesTruncated,
        gammaCacheEntries: input.gammaCacheEntries,
      })
    )
    .digest("hex");
}

export function prepareAuthoritativeEventsForLifecycleMerge(
  authoritativeEvents: WalletLedgerEvent[]
): WalletLedgerEvent[] {
  return sortLedgerEventsCanonical(
    backfillAuthoritativeLogIndexFromLookup(authoritativeEvents).events
  );
}

export function buildLifecycleInput(
  apiEvents: WalletLedgerEvent[],
  authoritativeEvents: WalletLedgerEvent[]
): WalletLedgerEvent[] {
  const chainEvents = prepareAuthoritativeEventsForLifecycleMerge(
    filterChainAuthoritativeEvents(authoritativeEvents)
  );
  return mergeApiAndChainEvents(apiEvents, chainEvents);
}

/** @deprecated Use hashLifecycleInputSequence for exact replay gates. */
export function hashLifecycleInput(events: WalletLedgerEvent[]): {
  count: number;
  hash: string;
} {
  return hashLifecycleInputLegacy(events);
}

export { hashLifecycleInputSequence } from "@/lib/walletLedger/indexed/store/lifecycleInputHash";

function hashGammaCacheEntries(
  entries: Array<[string, GammaMarketResolution]>
): string {
  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
}

function hashApiEventKeys(events: WalletLedgerEvent[]): string {
  return createHash("sha256")
    .update(events.map((event) => event.dedupeKey).sort().join("\n"))
    .digest("hex");
}

function metricsFromAudit(audit: IndexedAuditWalletResult): WalletValidationSnapshotMetrics {
  const metrics = audit.indexedLedgerMetrics;
  const immunity = audit.sourceTruncationImmunity;
  const policyAVerdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: Boolean(metrics?.credibilityMetricsValid),
    historyValidity: metrics?.historyValidity,
    completedPositionCount: metrics?.completedPositionCount ?? null,
    realizedRoi: metrics?.portfolioRealizedRoi ?? null,
    profitablePositionRate: metrics?.profitablePositionRate ?? null,
    metricVersion: WALLET_METRIC_VERSION,
  }).historicalPerformanceDecision;

  return {
    completedPositions: metrics?.completedPositionCount ?? 0,
    realizedRoi: metrics?.portfolioRealizedRoi ?? 0,
    profitablePositionRate: metrics?.profitablePositionRate ?? 0,
    historyValidity: metrics?.historyValidity ?? "",
    credibilityMetricsValid: Boolean(metrics?.credibilityMetricsValid),
    policyAVerdict,
    lifecycleEpisodeCount: audit.indexedLifecyclePositions?.length ?? 0,
  };
}

export function buildValidationSnapshotFromAudit(
  audit: IndexedAuditWalletResult,
  input: {
    apiEvents: WalletLedgerEvent[];
    gammaCacheEntries?: Array<[string, GammaMarketResolution]>;
    runId?: string;
  }
): WalletValidationSnapshot {
  const authoritativeEvents = prepareAuthoritativeEventsForLifecycleMerge(
    filterChainAuthoritativeEvents(audit.authoritativeIndexedEvents ?? [])
  );
  const apiEvents = sortLedgerEventsCanonical(
    input.apiEvents ?? audit.apiEvents ?? []
  );
  const immunity = audit.sourceTruncationImmunity;
  const gammaCacheEntries =
    input.gammaCacheEntries ?? audit.gammaCacheEntries ?? [];
  const combined = buildLifecycleInput(apiEvents, authoritativeEvents);
  const lifecycleInput = hashLifecycleInputLegacy(combined);
  const lifecycleSequence = hashLifecycleInputSequence(combined);
  const metricComputationInputHash = hashReplayInput({
    apiEvents,
    authoritativeEvents,
    activityTruncated: immunity?.activityTruncated ?? false,
    tradesTruncated: immunity?.tradesTruncated ?? false,
    gammaCacheEntries,
  });
  const runId =
    input.runId ??
    `${audit.wallet.toLowerCase()}-${Date.now().toString(36)}`;

  return {
    wallet: audit.wallet.toLowerCase(),
    runId,
    runTimestamp: new Date().toISOString(),
    metricVersion: WALLET_METRIC_VERSION,
    chainId: "137",
    scanFromBlock: audit.scanFromBlock ?? null,
    throughBlock: audit.throughBlock ?? null,
    apiEvents,
    authoritativeEvents,
    authoritativeEventCount: authoritativeEvents.length,
    authoritativeEventIdentityHash:
      hashAuthoritativeEventIdentities(authoritativeEvents),
    combinedEventCount: combined.length,
    replayInputHash: metricComputationInputHash,
    metricComputationInputHash,
    auditLifecycleInputHash: lifecycleInput.hash,
    auditLifecycleInputCount: lifecycleInput.count,
    auditLifecycleInputSequenceHash: lifecycleSequence.hash,
    auditLifecycleInputEventCount: lifecycleSequence.count,
    oldestActivityTimestamp: audit.coverage.oldestActivityTimestamp,
    oldestTradesTimestamp: audit.coverage.oldestTradesTimestamp,
    activityTruncated: immunity?.activityTruncated ?? false,
    tradesTruncated: immunity?.tradesTruncated ?? false,
    gammaCacheEntries,
    auditMetrics: metricsFromAudit(audit),
    lifecycleEpisodeKeys: (audit.indexedLifecyclePositions ?? [])
      .map(lifecycleEpisodeKey)
      .sort(),
  };
}

export function snapshotPath(wallet: string, runId: string): string {
  return path.join(
    SNAPSHOT_ROOT,
    `${wallet.toLowerCase()}-${runId}.json`
  );
}

export async function saveValidationSnapshot(
  snapshot: WalletValidationSnapshot
): Promise<string> {
  await mkdir(SNAPSHOT_ROOT, { recursive: true });
  const filePath = snapshotPath(snapshot.wallet, snapshot.runId);
  await writeFile(filePath, JSON.stringify(snapshot), "utf8");
  return filePath;
}

export async function loadValidationSnapshot(
  filePath: string
): Promise<WalletValidationSnapshot> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as WalletValidationSnapshot;
}

export interface ReplayValidationSnapshotOptions {
  chainEventsOverride?: WalletLedgerEvent[];
  /** When true (default), never refetch gamma — only seeded snapshot entries. */
  frozen?: boolean;
}

export interface ReplayValidationSnapshotResult
  extends WalletValidationReplayResult {
  replayLifecycleInputHash: string;
  replayLifecycleInputCount: number;
  replayLifecycleInputSequenceHash: string;
  replayLifecycleInputEventCount: number;
  replayInputHash: string;
  inputMismatch: boolean;
  inputMismatchReason?: string;
  fullLedgerMetrics: import("@/lib/walletLedger/types").WalletLedgerMetrics;
}

export async function replayMetricsFromValidationSnapshot(
  snapshot: WalletValidationSnapshot,
  options: ReplayValidationSnapshotOptions = {}
): Promise<ReplayValidationSnapshotResult> {
  const chainEvents = prepareAuthoritativeEventsForLifecycleMerge(
    options.chainEventsOverride ?? snapshot.authoritativeEvents
  );
  const combined = buildLifecycleInput(snapshot.apiEvents, chainEvents);
  const lifecycleInput = hashLifecycleInputLegacy(combined);
  const lifecycleSequence = hashLifecycleInputSequence(combined);
  const replayInputHash = hashReplayInput({
    apiEvents: snapshot.apiEvents,
    authoritativeEvents: chainEvents,
    activityTruncated: snapshot.activityTruncated,
    tradesTruncated: snapshot.tradesTruncated,
    gammaCacheEntries: snapshot.gammaCacheEntries,
  });
  const expectedInputHash =
    snapshot.metricComputationInputHash ?? snapshot.replayInputHash;
  const expectedLifecycleHash = snapshot.auditLifecycleInputHash;
  const expectedSequenceHash =
    snapshot.auditLifecycleInputSequenceHash ?? snapshot.auditLifecycleInputHash;
  const expectedEventCount =
    snapshot.auditLifecycleInputEventCount ?? snapshot.auditLifecycleInputCount;
  let inputMismatch = false;
  let inputMismatchReason: string | undefined;
  if (replayInputHash !== expectedInputHash) {
    inputMismatch = true;
    inputMismatchReason = `replayInputHash mismatch: expected ${expectedInputHash} got ${replayInputHash}`;
  } else if (lifecycleSequence.count !== expectedEventCount) {
    inputMismatch = true;
    inputMismatchReason = `lifecycleInputEventCount mismatch: expected ${expectedEventCount} got ${lifecycleSequence.count}`;
  } else if (
    expectedSequenceHash &&
    lifecycleSequence.hash !== expectedSequenceHash
  ) {
    inputMismatch = true;
    inputMismatchReason = `lifecycleInputSequenceHash mismatch: expected ${expectedSequenceHash} got ${lifecycleSequence.hash}`;
  } else if (
    expectedLifecycleHash &&
    lifecycleInput.hash !== expectedLifecycleHash
  ) {
    inputMismatch = true;
    inputMismatchReason = `lifecycleInputHash mismatch: expected ${expectedLifecycleHash} got ${lifecycleInput.hash}`;
  }
  if (inputMismatch && (options.frozen ?? true)) {
    throw new Error(`INPUT_MISMATCH: ${inputMismatchReason}`);
  }

  const gammaCache = new GammaResolutionCache();
  gammaCache.seedMany(snapshot.gammaCacheEntries);
  const frozen = options.frozen ?? true;
  gammaCache.setFrozen(frozen);
  if (!frozen) {
    await gammaCache.prefetch(buildMarketResolveHints(combined));
  }
  const { positions } = await buildPositionLifecycles(
    snapshot.wallet,
    combined,
    gammaCache
  );
  const mergeSplit = analyzeMergeSplitImpact(positions);
  const unresolvedChainOrder = assessUnresolvedChainOrder(chainEvents);
  const metrics = computeWalletLedgerMetrics({
    positions,
    identity: {
      requestedWallet: snapshot.wallet,
      historyWallet: snapshot.wallet,
      confidence: "high",
      resolutionMethod: "proxy_wallet_direct",
      candidateWallets: [],
      alternateCandidates: [],
      evidence: { notes: ["validation_snapshot_replay"] },
      positionsOnlyMismatch: false,
      activityCount: combined.length,
      tradeCount: combined.filter(
        (event) => event.type === "BUY" || event.type === "SELL"
      ).length,
      positionsCount: positions.length,
    },
    activityTruncated: snapshot.activityTruncated,
    tradesTruncated: snapshot.tradesTruncated,
    rawEventCount: combined.length,
    deduplicatedEventCount: combined.length,
    gammaCoverage: {
      distinctMarkets: new Set(positions.map((p) => p.conditionId).filter(Boolean))
        .size,
      marketsFoundBefore: 1,
      marketsFoundAfter: 1,
      resolvedBefore: 0,
      resolvedAfter: 0,
      coverageBeforePct: 1,
      coverageAfterPct: 1,
      marketFoundCoverageAfterPct: 1,
    },
    mergeSplit,
    hasHistoryEvents: combined.length > 0,
    unresolvedChainOrderBlocksCredibility: unresolvedChainOrder.blocksCredibility,
    unresolvedChainEvents: unresolvedChainOrder.unresolvedChainEvents,
    unresolvedChainEventsInLifecycle:
      unresolvedChainOrder.unresolvedChainEventsInLifecycle,
    affectedPositionGroups: unresolvedChainOrder.affectedPositionGroups,
  });
  const policyAVerdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: metrics.credibilityMetricsValid,
    historyValidity: metrics.historyValidity,
    completedPositionCount: metrics.completedPositionCount,
    realizedRoi: metrics.portfolioRealizedRoi,
    profitablePositionRate: metrics.profitablePositionRate,
    metricVersion: WALLET_METRIC_VERSION,
  }).historicalPerformanceDecision;

  return {
    metrics: {
      completedPositions: metrics.completedPositionCount ?? 0,
      realizedRoi: metrics.portfolioRealizedRoi ?? 0,
      profitablePositionRate: metrics.profitablePositionRate ?? 0,
      historyValidity: metrics.historyValidity,
      credibilityMetricsValid: metrics.credibilityMetricsValid,
      policyAVerdict,
      lifecycleEpisodeCount: positions.length,
    },
    positions,
    combinedEventCount: combined.length,
    replayLifecycleInputHash: lifecycleInput.hash,
    replayLifecycleInputCount: lifecycleInput.count,
    replayLifecycleInputSequenceHash: lifecycleSequence.hash,
    replayLifecycleInputEventCount: lifecycleSequence.count,
    replayInputHash,
    inputMismatch,
    inputMismatchReason,
    fullLedgerMetrics: metrics,
  };
}

export async function verifyValidationSnapshotReplay(
  snapshot: WalletValidationSnapshot
): Promise<{
  inputMatch: boolean;
  metricsMatch: boolean;
  replay: ReplayValidationSnapshotResult;
  comparison: ReturnType<typeof compareReplayToSnapshot>;
}> {
  const replay = await replayMetricsFromValidationSnapshot(snapshot, {
    frozen: true,
  });
  const comparison = compareReplayToSnapshot(snapshot, replay);
  return {
    inputMatch: !replay.inputMismatch,
    metricsMatch: comparison.exactMatch,
    replay,
    comparison,
  };
}

export async function verifyLifecycleEpisodeDeterminism(
  wallet: string,
  combinedEvents: WalletLedgerEvent[],
  gammaCacheEntries: Array<[string, GammaMarketResolution]>
): Promise<{
  deterministic: boolean;
  firstCount: number;
  secondCount: number;
  episodeKeysMatch: boolean;
  completedMatch: boolean;
  realizedPnlMatch: boolean;
  profitableRateMatch: boolean;
  onlyInFirst: string[];
  onlyInSecond: string[];
}> {
  const firstGamma = new GammaResolutionCache();
  firstGamma.seedMany(gammaCacheEntries);
  firstGamma.setFrozen(true);
  const first = await buildPositionLifecycles(wallet, combinedEvents, firstGamma);

  const secondGamma = new GammaResolutionCache();
  secondGamma.seedMany(gammaCacheEntries);
  secondGamma.setFrozen(true);
  const secondResult = await buildPositionLifecycles(
    wallet,
    combinedEvents,
    secondGamma
  );

  const firstKeys = first.positions.map(lifecycleEpisodeKey).sort();
  const secondKeys = secondResult.positions.map(lifecycleEpisodeKey).sort();
  const firstSet = new Set(firstKeys);
  const secondSet = new Set(secondKeys);
  const onlyInFirst = firstKeys.filter((key) => !secondSet.has(key));
  const onlyInSecond = secondKeys.filter((key) => !firstSet.has(key));

  const firstCompleted = first.positions.filter((p) => p.completed).length;
  const secondCompleted = secondResult.positions.filter((p) => p.completed)
    .length;
  const firstPnl = first.positions.reduce(
    (sum, position) => sum + (position.realizedPnl ?? 0),
    0
  );
  const secondPnl = secondResult.positions.reduce(
    (sum, position) => sum + (position.realizedPnl ?? 0),
    0
  );
  const firstProfitable =
    firstCompleted > 0
      ? first.positions.filter((p) => p.completed && (p.realizedPnl ?? 0) > 0)
          .length / firstCompleted
      : 0;
  const secondProfitable =
    secondCompleted > 0
      ? secondResult.positions.filter(
          (p) => p.completed && (p.realizedPnl ?? 0) > 0
        ).length / secondCompleted
      : 0;

  return {
    deterministic:
      firstKeys.join("\n") === secondKeys.join("\n") &&
      firstCompleted === secondCompleted &&
      Math.abs(firstPnl - secondPnl) <= 1e-9 &&
      Math.abs(firstProfitable - secondProfitable) <= 1e-9,
    firstCount: first.positions.length,
    secondCount: secondResult.positions.length,
    episodeKeysMatch: firstKeys.join("\n") === secondKeys.join("\n"),
    completedMatch: firstCompleted === secondCompleted,
    realizedPnlMatch: Math.abs(firstPnl - secondPnl) <= 1e-9,
    profitableRateMatch: Math.abs(firstProfitable - secondProfitable) <= 1e-9,
    onlyInFirst,
    onlyInSecond,
  };
}

export function compareReplayToSnapshot(
  snapshot: WalletValidationSnapshot,
  replay: WalletValidationReplayResult
): {
  exactMatch: boolean;
  completedDelta: number;
  roiDelta: number;
  profitableRateDelta: number;
  policyAMatch: boolean;
  lifecycleEpisodeMatch: boolean;
  lifecycleEpisodeKeysMatch: boolean;
  lifecycleSequenceHashMatch?: boolean;
} {
  const completedDelta =
    replay.metrics.completedPositions - snapshot.auditMetrics.completedPositions;
  const roiDelta =
    replay.metrics.realizedRoi - snapshot.auditMetrics.realizedRoi;
  const profitableRateDelta =
    replay.metrics.profitablePositionRate -
    snapshot.auditMetrics.profitablePositionRate;
  const policyAMatch =
    replay.metrics.policyAVerdict === snapshot.auditMetrics.policyAVerdict;
  const lifecycleEpisodeMatch =
    replay.metrics.lifecycleEpisodeCount ===
    snapshot.auditMetrics.lifecycleEpisodeCount;
  const lifecycleEpisodeKeysMatch =
    [...replay.positions.map(lifecycleEpisodeKey)].sort().join("\n") ===
    [...snapshot.lifecycleEpisodeKeys].sort().join("\n");
  const exactMatch =
    completedDelta === 0 &&
    policyAMatch &&
    lifecycleEpisodeMatch &&
    lifecycleEpisodeKeysMatch &&
    Math.abs(roiDelta) <= 1e-9 &&
    Math.abs(profitableRateDelta) <= 1e-9;

  return {
    exactMatch,
    completedDelta,
    roiDelta,
    profitableRateDelta,
    policyAMatch,
    lifecycleEpisodeMatch,
    lifecycleEpisodeKeysMatch,
  };
}

export async function buildPostRecoveryValidationSnapshot(input: {
  wallet: string;
  priorSnapshot: WalletValidationSnapshot;
  authoritativeEvents: WalletLedgerEvent[];
  runId?: string;
}): Promise<WalletValidationSnapshot> {
  const authoritativeEvents = prepareAuthoritativeEventsForLifecycleMerge(
    filterChainAuthoritativeEvents(input.authoritativeEvents)
  );
  const combined = buildLifecycleInput(
    input.priorSnapshot.apiEvents,
    authoritativeEvents
  );
  const lifecycleInput = hashLifecycleInputLegacy(combined);
  const lifecycleSequence = hashLifecycleInputSequence(combined);
  const metricComputationInputHash = hashReplayInput({
    apiEvents: input.priorSnapshot.apiEvents,
    authoritativeEvents,
    activityTruncated: input.priorSnapshot.activityTruncated,
    tradesTruncated: input.priorSnapshot.tradesTruncated,
    gammaCacheEntries: input.priorSnapshot.gammaCacheEntries,
  });
  const replay = await replayMetricsFromValidationSnapshot(
    {
      ...input.priorSnapshot,
      wallet: input.wallet.toLowerCase(),
      authoritativeEvents,
      authoritativeEventCount: authoritativeEvents.length,
      authoritativeEventIdentityHash:
        hashAuthoritativeEventIdentities(authoritativeEvents),
      combinedEventCount: combined.length,
      replayInputHash: metricComputationInputHash,
      metricComputationInputHash,
      auditLifecycleInputHash: lifecycleInput.hash,
      auditLifecycleInputCount: lifecycleInput.count,
      auditLifecycleInputSequenceHash: lifecycleSequence.hash,
      auditLifecycleInputEventCount: lifecycleSequence.count,
      lifecycleEpisodeKeys: [],
      auditMetrics: {
        completedPositions: 0,
        realizedRoi: 0,
        profitablePositionRate: 0,
        historyValidity: "",
        credibilityMetricsValid: false,
        policyAVerdict: "UNKNOWN",
        lifecycleEpisodeCount: 0,
      },
    },
    {
      chainEventsOverride: authoritativeEvents,
      frozen: true,
    }
  );

  const runId =
    input.runId ??
    `${input.wallet.toLowerCase()}-post-recovery-${Date.now().toString(36)}`;

  return {
    wallet: input.wallet.toLowerCase(),
    runId,
    runTimestamp: new Date().toISOString(),
    metricVersion: input.priorSnapshot.metricVersion,
    chainId: input.priorSnapshot.chainId,
    scanFromBlock: input.priorSnapshot.scanFromBlock,
    throughBlock: input.priorSnapshot.throughBlock,
    apiEvents: input.priorSnapshot.apiEvents,
    authoritativeEvents,
    authoritativeEventCount: authoritativeEvents.length,
    authoritativeEventIdentityHash:
      hashAuthoritativeEventIdentities(authoritativeEvents),
    combinedEventCount: combined.length,
    replayInputHash: metricComputationInputHash,
    metricComputationInputHash,
    auditLifecycleInputHash: lifecycleInput.hash,
    auditLifecycleInputCount: lifecycleInput.count,
    auditLifecycleInputSequenceHash: lifecycleSequence.hash,
    auditLifecycleInputEventCount: lifecycleSequence.count,
    oldestActivityTimestamp: input.priorSnapshot.oldestActivityTimestamp,
    oldestTradesTimestamp: input.priorSnapshot.oldestTradesTimestamp,
    activityTruncated: input.priorSnapshot.activityTruncated,
    tradesTruncated: input.priorSnapshot.tradesTruncated,
    gammaCacheEntries: input.priorSnapshot.gammaCacheEntries,
    auditMetrics: replay.metrics,
    lifecycleEpisodeKeys: replay.positions.map(lifecycleEpisodeKey).sort(),
  };
}

export function analyzeMetricMovementFromSnapshots(input: {
  oldSnapshot: WalletValidationSnapshot;
  newSnapshot: WalletValidationSnapshot;
  oldReplay?: WalletValidationReplayResult;
  newReplay?: WalletValidationReplayResult;
}): {
  completedPositionsDelta: number;
  roiDelta: number;
  profitableRateDelta: number;
  lifecycleEpisodeCountDelta: number;
  positionGroupsChanged: number;
  completedEpisodesAdded: number;
  completedEpisodesRemoved: number;
  largestPnlChanges: Array<{
    conditionId: string;
    asset: string;
    oldPnl: number;
    newPnl: number;
    delta: number;
  }>;
  allChangesFromChainOrdering: boolean;
} {
  const oldKeys = new Set(input.oldSnapshot.lifecycleEpisodeKeys);
  const newKeys = new Set(input.newSnapshot.lifecycleEpisodeKeys);
  const onlyOld = [...oldKeys].filter((key) => !newKeys.has(key));
  const onlyNew = [...newKeys].filter((key) => !oldKeys.has(key));

  const oldPositions = input.oldReplay?.positions ?? [];
  const newPositions = input.newReplay?.positions ?? [];
  const oldByGroup = new Map(
    oldPositions.map((position) => [
      `${position.conditionId}|${position.asset}`,
      position,
    ])
  );
  const newByGroup = new Map(
    newPositions.map((position) => [
      `${position.conditionId}|${position.asset}`,
      position,
    ])
  );

  const pnlChanges: Array<{
    conditionId: string;
    asset: string;
    oldPnl: number;
    newPnl: number;
    delta: number;
  }> = [];
  for (const [groupKey, oldPosition] of oldByGroup.entries()) {
    const newPosition = newByGroup.get(groupKey);
    if (!newPosition) continue;
    const oldPnl = oldPosition.realizedPnl ?? 0;
    const newPnl = newPosition.realizedPnl ?? 0;
    if (Math.abs(oldPnl - newPnl) > 1e-9) {
      pnlChanges.push({
        conditionId: oldPosition.conditionId,
        asset: oldPosition.asset,
        oldPnl,
        newPnl,
        delta: newPnl - oldPnl,
      });
    }
  }
  pnlChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const oldCompleted = input.oldSnapshot.auditMetrics.completedPositions;
  const newCompleted = input.newSnapshot.auditMetrics.completedPositions;

  return {
    completedPositionsDelta: newCompleted - oldCompleted,
    roiDelta:
      input.newSnapshot.auditMetrics.realizedRoi -
      input.oldSnapshot.auditMetrics.realizedRoi,
    profitableRateDelta:
      input.newSnapshot.auditMetrics.profitablePositionRate -
      input.oldSnapshot.auditMetrics.profitablePositionRate,
    lifecycleEpisodeCountDelta:
      input.newSnapshot.auditMetrics.lifecycleEpisodeCount -
      input.oldSnapshot.auditMetrics.lifecycleEpisodeCount,
    positionGroupsChanged: new Set([
      ...onlyOld.map((key) => key.split("|")[0]),
      ...onlyNew.map((key) => key.split("|")[0]),
    ]).size,
    completedEpisodesAdded: Math.max(0, newCompleted - oldCompleted),
    completedEpisodesRemoved: Math.max(0, oldCompleted - newCompleted),
    largestPnlChanges: pnlChanges.slice(0, 10),
    allChangesFromChainOrdering:
      input.oldSnapshot.authoritativeEventIdentityHash !==
      input.newSnapshot.authoritativeEventIdentityHash,
  };
}
