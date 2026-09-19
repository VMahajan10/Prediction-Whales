import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletPositionLifecycles } from "@/lib/crossmarket/store/schema";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { positionKey } from "@/lib/walletLedger/normalize";
import { withDbCircuit } from "@/lib/walletLedger/indexed/shadow/dbCircuitBreaker";
import { retryTransient } from "@/lib/walletLedger/indexed/shadow/transientRetry";
import { withDbQueryTimeout } from "@/lib/walletLedger/indexed/store/dbQueryTimeout";
import { assertPersistenceNotAborted } from "@/lib/walletLedger/indexed/store/persistenceAbort";
import type { PositionLifecycle, WalletLedgerEvent } from "@/lib/walletLedger/types";

export type LifecyclePositionKey = {
  conditionId: string;
  assetId: string;
  lifecycleEpisode?: number;
};

export type PersistedLifecycleRow = {
  conditionId: string;
  assetId: string;
  lifecycleEpisode: number;
  completed: boolean;
  completionType: string | null;
  capitalAtRisk: number;
  buyNotional: number;
  sellNotional: number;
  resolutionPayout: number;
  realizedPnl: number | null;
  realizedRoi: number | null;
  profitable: boolean | null;
  outcomeWin: boolean | null;
  openedAt: number | null;
  completedAt: number | null;
  exclusionReason: string | null;
  resolutionSource: string | null;
  resolutionFinal: boolean | null;
};

export type LifecyclePersistMode = "full" | "incremental";

export interface LifecyclePersistStats {
  lifecycleMode: LifecyclePersistMode;
  lifecyclesAffected: number;
  lifecyclesInserted: number;
  lifecyclesUpdated: number;
  lifecyclesUnchanged: number;
  lifecycleWriteMs: number;
}

const FLOAT_EPSILON = 1e-9;

/** Insert payload columns per lifecycle row (excludes id / calculatedAt default). */
export const LIFECYCLE_INSERT_VALUE_COLUMNS = 20;

/** Postgres parameter budget: 19 cols × 200 rows = 3,800 params per batch. */
export const LIFECYCLE_PERSIST_BATCH_SIZE = 200;

export const LIFECYCLE_PROGRESS_ROW_INTERVAL = 2_000;
export const LIFECYCLE_PROGRESS_TIME_MS = 30_000;

const LIFECYCLE_CONFLICT_UPDATE_SET = {
  completed: sql`excluded.completed`,
  completionType: sql`excluded.completion_type`,
  capitalAtRisk: sql`excluded.capital_at_risk`,
  buyNotional: sql`excluded.buy_notional`,
  sellNotional: sql`excluded.sell_notional`,
  resolutionPayout: sql`excluded.resolution_payout`,
  realizedPnl: sql`excluded.realized_pnl`,
  realizedRoi: sql`excluded.realized_roi`,
  profitable: sql`excluded.profitable`,
  outcomeWin: sql`excluded.outcome_win`,
  openedAt: sql`excluded.opened_at`,
  completedAt: sql`excluded.completed_at`,
  exclusionReason: sql`excluded.exclusion_reason`,
  resolutionSource: sql`excluded.resolution_source`,
  resolutionFinal: sql`excluded.resolution_final`,
  calculatedAt: sql`now()`,
} as const;

export type LifecycleWriteEntry = {
  key: string;
  position: PositionLifecycle;
  row: PersistedLifecycleRow;
  action: "insert" | "update" | "unchanged";
};

export function lifecycleInsertValues(
  walletAddress: string,
  row: PersistedLifecycleRow
) {
  return {
    walletAddress,
    conditionId: row.conditionId,
    assetId: row.assetId,
    metricVersion: WALLET_METRIC_VERSION,
    lifecycleEpisode: row.lifecycleEpisode,
    completed: row.completed,
    completionType: row.completionType,
    capitalAtRisk: row.capitalAtRisk,
    buyNotional: row.buyNotional,
    sellNotional: row.sellNotional,
    resolutionPayout: row.resolutionPayout,
    realizedPnl: row.realizedPnl,
    realizedRoi: row.realizedRoi,
    profitable: row.profitable,
    outcomeWin: row.outcomeWin,
    openedAt: row.openedAt,
    completedAt: row.completedAt,
    exclusionReason: row.exclusionReason,
    resolutionSource: row.resolutionSource,
    resolutionFinal: row.resolutionFinal,
  };
}

export function planLifecycleWriteBatches(
  writes: LifecycleWriteEntry[],
  batchSize = LIFECYCLE_PERSIST_BATCH_SIZE
): LifecycleWriteEntry[][] {
  const toWrite = writes.filter((w) => w.action !== "unchanged");
  const batches: LifecycleWriteEntry[][] = [];
  for (let i = 0; i < toWrite.length; i += batchSize) {
    batches.push(toWrite.slice(i, i + batchSize));
  }
  return batches;
}

export function logLifecyclePersistProgress(input: {
  wallet: string;
  persisted: number;
  total: number;
  startedAt: number;
  lastSuccessfulBatchAt: string;
}): void {
  const elapsedSeconds = (Date.now() - input.startedAt) / 1000;
  const rowsPerSecond =
    elapsedSeconds > 0 ? input.persisted / elapsedSeconds : 0;
  console.error(
    `[lifecycle-persist-progress] wallet=${input.wallet} phase=lifecycle-persist ` +
      `persisted=${input.persisted}/${input.total} ` +
      `rowsPerSecond=${rowsPerSecond.toFixed(1)} ` +
      `elapsedSeconds=${elapsedSeconds.toFixed(1)} ` +
      `lastSuccessfulBatchAt=${input.lastSuccessfulBatchAt}`
  );
}

export async function upsertLifecycleWriteBatch(
  walletAddress: string,
  batch: LifecycleWriteEntry[]
): Promise<void> {
  if (batch.length === 0) return;
  const db = getDb();
  await withDbCircuit("upsertLifecycleWriteBatch", () =>
    withDbQueryTimeout("upsertLifecycleWriteBatch", () =>
      retryTransient(
        () =>
          db
            .insert(walletPositionLifecycles)
            .values(batch.map((entry) => lifecycleInsertValues(walletAddress, entry.row)))
            .onConflictDoUpdate({
              target: [
                walletPositionLifecycles.walletAddress,
                walletPositionLifecycles.conditionId,
                walletPositionLifecycles.assetId,
                walletPositionLifecycles.metricVersion,
                walletPositionLifecycles.lifecycleEpisode,
              ],
              set: LIFECYCLE_CONFLICT_UPDATE_SET,
            }),
        { maxAttempts: 4, label: "upsertLifecycleWriteBatch" }
      )
    )
  );
}

export function lifecycleBaseKeyString(key: {
  conditionId: string;
  assetId: string;
}): string {
  return `${key.conditionId}::${key.assetId}`;
}

export function lifecycleKeyString(key: LifecyclePositionKey): string {
  const episode = key.lifecycleEpisode ?? 0;
  return `${key.conditionId}::${key.assetId}::${episode}`;
}

export function lifecycleBaseKeyFromPosition(position: PositionLifecycle): string {
  return lifecycleBaseKeyString({
    conditionId: position.conditionId,
    assetId: position.asset,
  });
}

export function lifecycleKeyFromPosition(position: PositionLifecycle): string {
  return lifecycleKeyString({
    conditionId: position.conditionId,
    assetId: position.asset,
    lifecycleEpisode: position.lifecycleEpisode,
  });
}

export function buildEventsByCondition(
  events: WalletLedgerEvent[]
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const event of events) {
    const conditionId = event.conditionId?.trim();
    const assetId = event.asset?.trim();
    if (!conditionId || !assetId) continue;
    const assets = map.get(conditionId) ?? new Set<string>();
    assets.add(assetId);
    map.set(conditionId, assets);
  }
  return map;
}

/** Keys directly referenced by one event (BUY/SELL/REDEEM). */
function directKeysFromEvent(event: WalletLedgerEvent): LifecyclePositionKey[] {
  const conditionId = event.conditionId?.trim();
  const assetId = event.asset?.trim();
  if (!conditionId || !assetId) return [];
  return [{ conditionId, assetId }];
}

/**
 * Derive lifecycle keys that may change from new/changed events.
 * MERGE/SPLIT can affect every asset on the condition for this wallet.
 */
export function affectedPositionKeysFromEvents(
  events: WalletLedgerEvent[],
  eventsByCondition: Map<string, Set<string>>
): Set<string> {
  const affected = new Set<string>();
  for (const event of events) {
    if (event.type === "MERGE" || event.type === "SPLIT") {
      const conditionId = event.conditionId?.trim();
      if (conditionId) {
        const assets = eventsByCondition.get(conditionId);
        if (assets) {
          for (const assetId of assets) {
            affected.add(lifecycleBaseKeyString({ conditionId, assetId }));
          }
        }
      }
      for (const key of directKeysFromEvent(event)) {
        affected.add(lifecycleBaseKeyString(key));
      }
      continue;
    }
    for (const key of directKeysFromEvent(event)) {
      affected.add(lifecycleBaseKeyString(key));
    }
    if (!event.asset && event.conditionId?.trim()) {
      const assets = eventsByCondition.get(event.conditionId.trim());
      if (assets) {
        for (const assetId of assets) {
          affected.add(
            lifecycleBaseKeyString({ conditionId: event.conditionId.trim(), assetId })
          );
        }
      }
    }
  }
  return affected;
}

function floatEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= FLOAT_EPSILON;
}

export function positionToPersistedRow(
  position: PositionLifecycle
): PersistedLifecycleRow {
  return {
    conditionId: position.conditionId,
    assetId: position.asset,
    lifecycleEpisode: position.lifecycleEpisode,
    completed: position.completed,
    completionType: position.completionReason,
    capitalAtRisk: position.capitalAtRisk,
    buyNotional: position.grossBuyCash,
    sellNotional: position.grossSellCash,
    resolutionPayout: position.resolutionPayoutUsd,
    realizedPnl: position.realizedPnl,
    realizedRoi: position.positionRoi,
    profitable: position.realizedPnl != null ? position.realizedPnl > 0 : null,
    outcomeWin: position.outcomeCorrect,
    openedAt: position.firstEntryAt,
    completedAt: position.lastActivityAt,
    exclusionReason: position.exclusionReason,
    resolutionSource: position.resolution?.source ?? null,
    resolutionFinal: position.resolution?.resolutionFinal ?? null,
  };
}

export function persistedLifecycleRowsEqual(
  computed: PersistedLifecycleRow,
  persisted: PersistedLifecycleRow
): boolean {
  return (
    computed.lifecycleEpisode === persisted.lifecycleEpisode &&
    computed.completed === persisted.completed &&
    computed.completionType === persisted.completionType &&
    floatEqual(computed.capitalAtRisk, persisted.capitalAtRisk) &&
    floatEqual(computed.buyNotional, persisted.buyNotional) &&
    floatEqual(computed.sellNotional, persisted.sellNotional) &&
    floatEqual(computed.resolutionPayout, persisted.resolutionPayout) &&
    floatEqual(computed.realizedPnl, persisted.realizedPnl) &&
    floatEqual(computed.realizedRoi, persisted.realizedRoi) &&
    computed.profitable === persisted.profitable &&
    computed.outcomeWin === persisted.outcomeWin &&
    computed.openedAt === persisted.openedAt &&
    computed.completedAt === persisted.completedAt &&
    computed.exclusionReason === persisted.exclusionReason &&
    computed.resolutionSource === persisted.resolutionSource &&
    computed.resolutionFinal === persisted.resolutionFinal
  );
}

/** Lifecycle rows that changed due to Gamma/on-chain resolution without new wallet events. */
export function resolutionAffectedPositionKeys(
  computedPositions: PositionLifecycle[],
  persistedRows: PersistedLifecycleRow[],
  alreadyAffected: Set<string>
): Set<string> {
  const persistedByEpisodeKey = new Map(
    persistedRows.map((row) => [
      lifecycleKeyString({
        conditionId: row.conditionId,
        assetId: row.assetId,
        lifecycleEpisode: row.lifecycleEpisode,
      }),
      row,
    ])
  );
  const affected = new Set<string>();
  for (const position of computedPositions) {
    const baseKey = lifecycleBaseKeyFromPosition(position);
    if (alreadyAffected.has(baseKey)) continue;
    const episodeKey = lifecycleKeyFromPosition(position);
    const persisted = persistedByEpisodeKey.get(episodeKey);
    if (!persisted) continue;
    const computed = positionToPersistedRow(position);
    if (!persistedLifecycleRowsEqual(computed, persisted)) {
      affected.add(baseKey);
    }
  }
  return affected;
}

export async function deleteStaleLifecycleEpisodes(
  walletAddress: string,
  affectedBaseKeys: Set<string>,
  computedPositions: PositionLifecycle[]
): Promise<number> {
  if (affectedBaseKeys.size === 0) return 0;
  const db = getDb();
  let deleted = 0;
  for (const baseKey of affectedBaseKeys) {
    const [conditionId, assetId] = baseKey.split("::");
    if (!conditionId || !assetId) continue;
    const expectedEpisodes = new Set(
      computedPositions
        .filter((position) => lifecycleBaseKeyFromPosition(position) === baseKey)
        .map((position) => position.lifecycleEpisode)
    );
    const existing = await db
      .select({ lifecycleEpisode: walletPositionLifecycles.lifecycleEpisode })
      .from(walletPositionLifecycles)
      .where(
        sql`lower(${walletPositionLifecycles.walletAddress}) = ${walletAddress} AND ${walletPositionLifecycles.conditionId} = ${conditionId} AND ${walletPositionLifecycles.assetId} = ${assetId} AND ${walletPositionLifecycles.metricVersion} = ${WALLET_METRIC_VERSION}`
      );
    for (const row of existing) {
      if (expectedEpisodes.has(row.lifecycleEpisode)) continue;
      const removed = await withDbCircuit("deleteStaleLifecycleEpisodes", () =>
        withDbQueryTimeout("deleteStaleLifecycleEpisodes", () =>
          db
            .delete(walletPositionLifecycles)
            .where(
              and(
                sql`lower(${walletPositionLifecycles.walletAddress}) = ${walletAddress}`,
                eq(walletPositionLifecycles.conditionId, conditionId),
                eq(walletPositionLifecycles.assetId, assetId),
                eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION),
                eq(walletPositionLifecycles.lifecycleEpisode, row.lifecycleEpisode)
              )
            )
            .returning({ id: walletPositionLifecycles.id })
        )
      );
      deleted += removed.length;
    }
  }
  return deleted;
}

export function planIncrementalLifecycleWrites(input: {
  allPositions: PositionLifecycle[];
  novelEvents: WalletLedgerEvent[];
  allEvents: WalletLedgerEvent[];
  persistedRows: PersistedLifecycleRow[];
}): {
  lifecycleMode: LifecyclePersistMode;
  affectedKeys: Set<string>;
  writes: Array<{
    key: string;
    position: PositionLifecycle;
    row: PersistedLifecycleRow;
    action: "insert" | "update" | "unchanged";
  }>;
} {
  const persistedByKey = new Map(
    input.persistedRows.map((row) => [
      lifecycleKeyString({
        conditionId: row.conditionId,
        assetId: row.assetId,
        lifecycleEpisode: row.lifecycleEpisode,
      }),
      row,
    ])
  );
  const lifecycleMode: LifecyclePersistMode =
    input.persistedRows.length === 0 ? "full" : "incremental";

  const positionsByBaseKey = new Map<string, PositionLifecycle[]>();
  for (const position of input.allPositions) {
    const baseKey = lifecycleBaseKeyFromPosition(position);
    const list = positionsByBaseKey.get(baseKey) ?? [];
    list.push(position);
    positionsByBaseKey.set(baseKey, list);
  }

  let affectedKeys: Set<string>;
  if (lifecycleMode === "full") {
    affectedKeys = new Set(positionsByBaseKey.keys());
  } else {
    const eventsByCondition = buildEventsByCondition(input.allEvents);
    const fromEvents = affectedPositionKeysFromEvents(
      input.novelEvents,
      eventsByCondition
    );
    const fromResolution = resolutionAffectedPositionKeys(
      input.allPositions,
      input.persistedRows,
      fromEvents
    );
    affectedKeys = new Set([...fromEvents, ...fromResolution]);
    for (const baseKey of positionsByBaseKey.keys()) {
      const episodes = positionsByBaseKey.get(baseKey) ?? [];
      const hasMissingEpisode = episodes.some(
        (position) => !persistedByKey.has(lifecycleKeyFromPosition(position))
      );
      if (hasMissingEpisode) {
        affectedKeys.add(baseKey);
      }
    }
  }

  const writes: Array<{
    key: string;
    position: PositionLifecycle;
    row: PersistedLifecycleRow;
    action: "insert" | "update" | "unchanged";
  }> = [];

  for (const baseKey of affectedKeys) {
    const episodes = positionsByBaseKey.get(baseKey) ?? [];
    for (const position of episodes) {
      const key = lifecycleKeyFromPosition(position);
      const row = positionToPersistedRow(position);
      const persisted = persistedByKey.get(key);
      if (!persisted) {
        writes.push({ key, position, row, action: "insert" });
        continue;
      }
      if (persistedLifecycleRowsEqual(row, persisted)) {
        writes.push({ key, position, row, action: "unchanged" });
        continue;
      }
      writes.push({ key, position, row, action: "update" });
    }
  }

  return { lifecycleMode, affectedKeys, writes };
}

export async function loadPersistedLifecycleRows(
  wallet: string,
  metricVersion = WALLET_METRIC_VERSION
): Promise<PersistedLifecycleRow[]> {
  const db = getDb();
  const walletAddress = wallet.toLowerCase();
  const rows = await db
    .select({
      conditionId: walletPositionLifecycles.conditionId,
      assetId: walletPositionLifecycles.assetId,
      lifecycleEpisode: walletPositionLifecycles.lifecycleEpisode,
      completed: walletPositionLifecycles.completed,
      completionType: walletPositionLifecycles.completionType,
      capitalAtRisk: walletPositionLifecycles.capitalAtRisk,
      buyNotional: walletPositionLifecycles.buyNotional,
      sellNotional: walletPositionLifecycles.sellNotional,
      resolutionPayout: walletPositionLifecycles.resolutionPayout,
      realizedPnl: walletPositionLifecycles.realizedPnl,
      realizedRoi: walletPositionLifecycles.realizedRoi,
      profitable: walletPositionLifecycles.profitable,
      outcomeWin: walletPositionLifecycles.outcomeWin,
      openedAt: walletPositionLifecycles.openedAt,
      completedAt: walletPositionLifecycles.completedAt,
      exclusionReason: walletPositionLifecycles.exclusionReason,
      resolutionSource: walletPositionLifecycles.resolutionSource,
      resolutionFinal: walletPositionLifecycles.resolutionFinal,
    })
    .from(walletPositionLifecycles)
    .where(
      sql`lower(${walletPositionLifecycles.walletAddress}) = ${walletAddress} AND ${walletPositionLifecycles.metricVersion} = ${metricVersion}`
    );
  return rows.map((row) => ({
    conditionId: row.conditionId,
    assetId: row.assetId,
    lifecycleEpisode: row.lifecycleEpisode,
    completed: row.completed,
    completionType: row.completionType,
    capitalAtRisk: row.capitalAtRisk,
    buyNotional: row.buyNotional,
    sellNotional: row.sellNotional,
    resolutionPayout: row.resolutionPayout,
    realizedPnl: row.realizedPnl,
    realizedRoi: row.realizedRoi,
    profitable: row.profitable,
    outcomeWin: row.outcomeWin,
    openedAt: row.openedAt,
    completedAt: row.completedAt,
    exclusionReason: row.exclusionReason,
    resolutionSource: row.resolutionSource,
    resolutionFinal: row.resolutionFinal,
  }));
}

export interface LifecycleParityAudit {
  currentVersionRowCount: number;
  replayEpisodeCount: number;
  replayKeysOnly: string[];
  persistedKeysOnly: string[];
  duplicatePersistedEpisodeKeys: string[];
  statusMismatches: string[];
  realizedPnlMismatches: string[];
  capitalAtRiskMismatches: string[];
  exactParity: boolean;
}

export function auditLifecycleParity(
  replayPositions: PositionLifecycle[],
  persistedRows: PersistedLifecycleRow[]
): LifecycleParityAudit {
  const replayByKey = new Map(
    replayPositions.map((position) => [
      lifecycleKeyFromPosition(position),
      positionToPersistedRow(position),
    ])
  );
  const persistedByKey = new Map(
    persistedRows.map((row) => [
      lifecycleKeyString({
        conditionId: row.conditionId,
        assetId: row.assetId,
        lifecycleEpisode: row.lifecycleEpisode,
      }),
      row,
    ])
  );

  const replayKeysOnly = [...replayByKey.keys()].filter(
    (key) => !persistedByKey.has(key)
  );
  const persistedKeysOnly = [...persistedByKey.keys()].filter(
    (key) => !replayByKey.has(key)
  );

  const keyCounts = new Map<string, number>();
  for (const row of persistedRows) {
    const key = lifecycleKeyString({
      conditionId: row.conditionId,
      assetId: row.assetId,
      lifecycleEpisode: row.lifecycleEpisode,
    });
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const duplicatePersistedEpisodeKeys = [...keyCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);

  const statusMismatches: string[] = [];
  const realizedPnlMismatches: string[] = [];
  const capitalAtRiskMismatches: string[] = [];

  for (const [key, replayRow] of replayByKey) {
    const persisted = persistedByKey.get(key);
    if (!persisted) continue;
    if (persisted.completed !== replayRow.completed) {
      statusMismatches.push(key);
    }
    if (!floatEqual(persisted.realizedPnl, replayRow.realizedPnl)) {
      realizedPnlMismatches.push(key);
    }
    if (!floatEqual(persisted.capitalAtRisk, replayRow.capitalAtRisk)) {
      capitalAtRiskMismatches.push(key);
    }
  }

  const exactParity =
    replayKeysOnly.length === 0 &&
    persistedKeysOnly.length === 0 &&
    duplicatePersistedEpisodeKeys.length === 0 &&
    statusMismatches.length === 0 &&
    realizedPnlMismatches.length === 0 &&
    capitalAtRiskMismatches.length === 0 &&
    persistedRows.length === replayPositions.length;

  return {
    currentVersionRowCount: persistedRows.length,
    replayEpisodeCount: replayPositions.length,
    replayKeysOnly,
    persistedKeysOnly,
    duplicatePersistedEpisodeKeys,
    statusMismatches,
    realizedPnlMismatches,
    capitalAtRiskMismatches,
    exactParity,
  };
}

export interface AtomicLifecycleReplaceStats extends LifecyclePersistStats {
  lifecycleRowsBefore: number;
  lifecycleRowsUpserted: number;
  staleLifecycleRowsDeleted: number;
  lifecycleRowsAfter: number;
  replayLifecycleEpisodeCount: number;
  lifecycleParity: boolean;
  lifecycleParityAudit: LifecycleParityAudit;
}

export function emptyAtomicLifecycleReplaceStats(): AtomicLifecycleReplaceStats {
  return {
    lifecycleMode: "incremental",
    lifecyclesAffected: 0,
    lifecyclesInserted: 0,
    lifecyclesUpdated: 0,
    lifecyclesUnchanged: 0,
    lifecycleWriteMs: 0,
    lifecycleRowsBefore: 0,
    lifecycleRowsUpserted: 0,
    staleLifecycleRowsDeleted: 0,
    lifecycleRowsAfter: 0,
    replayLifecycleEpisodeCount: 0,
    lifecycleParity: true,
    lifecycleParityAudit: {
      currentVersionRowCount: 0,
      replayEpisodeCount: 0,
      replayKeysOnly: [],
      persistedKeysOnly: [],
      duplicatePersistedEpisodeKeys: [],
      statusMismatches: [],
      realizedPnlMismatches: [],
      capitalAtRiskMismatches: [],
      exactParity: true,
    },
  };
}

/**
 * Phase-2 commit: atomically replace current wallet+metricVersion lifecycle rows
 * with the replay set (upsert all episodes, delete stale current-version rows).
 */
export async function atomicReplaceCurrentVersionWalletLifecycles(
  wallet: string,
  allPositions: PositionLifecycle[],
  input: { abortSignal?: AbortSignal } = {}
): Promise<AtomicLifecycleReplaceStats> {
  const started = Date.now();
  const walletAddress = wallet.toLowerCase();
  assertPersistenceNotAborted(input.abortSignal, "lifecycle-persist-load");

  const persistedRowsBefore = await withDbCircuit("loadPersistedLifecycleRows", () =>
    withDbQueryTimeout("loadPersistedLifecycleRows", () =>
      loadPersistedLifecycleRows(walletAddress)
    )
  );
  const lifecycleRowsBefore = persistedRowsBefore.length;
  const expectedKeys = new Set(allPositions.map(lifecycleKeyFromPosition));
  const persistedByKey = new Map(
    persistedRowsBefore.map((row) => [
      lifecycleKeyString({
        conditionId: row.conditionId,
        assetId: row.assetId,
        lifecycleEpisode: row.lifecycleEpisode,
      }),
      row,
    ])
  );

  const writes: LifecycleWriteEntry[] = allPositions.map((position) => {
    const key = lifecycleKeyFromPosition(position);
    const row = positionToPersistedRow(position);
    const persisted = persistedByKey.get(key);
    if (!persisted) {
      return { key, position, row, action: "insert" as const };
    }
    if (persistedLifecycleRowsEqual(row, persisted)) {
      return { key, position, row, action: "unchanged" as const };
    }
    return { key, position, row, action: "update" as const };
  });

  let lifecyclesInserted = 0;
  let lifecyclesUpdated = 0;
  const toUpsert = writes.filter((entry) => entry.action !== "unchanged");
  const batches = planLifecycleWriteBatches(writes);
  let persisted = 0;
  const total = toUpsert.length;
  let lastLogAt = started;
  let lastSuccessfulBatchAt = new Date(started).toISOString();

  for (const batch of batches) {
    assertPersistenceNotAborted(input.abortSignal, "lifecycle-persist");
    await upsertLifecycleWriteBatch(walletAddress, batch);
    for (const entry of batch) {
      if (entry.action === "insert") lifecyclesInserted += 1;
      else lifecyclesUpdated += 1;
    }
    persisted += batch.length;
    lastSuccessfulBatchAt = new Date().toISOString();
    const now = Date.now();
    if (
      persisted % LIFECYCLE_PROGRESS_ROW_INTERVAL === 0 ||
      persisted === total ||
      now - lastLogAt >= LIFECYCLE_PROGRESS_TIME_MS
    ) {
      logLifecyclePersistProgress({
        wallet,
        persisted,
        total,
        startedAt: started,
        lastSuccessfulBatchAt,
      });
      lastLogAt = now;
    }
  }

  let staleLifecycleRowsDeleted = 0;
  const db = getDb();
  for (const row of persistedRowsBefore) {
    const key = lifecycleKeyString({
      conditionId: row.conditionId,
      assetId: row.assetId,
      lifecycleEpisode: row.lifecycleEpisode,
    });
    if (expectedKeys.has(key)) continue;
    const removed = await withDbCircuit("deleteStaleCurrentVersionLifecycle", () =>
      withDbQueryTimeout("deleteStaleCurrentVersionLifecycle", () =>
        db
          .delete(walletPositionLifecycles)
          .where(
            and(
              sql`lower(${walletPositionLifecycles.walletAddress}) = ${walletAddress}`,
              eq(walletPositionLifecycles.conditionId, row.conditionId),
              eq(walletPositionLifecycles.assetId, row.assetId),
              eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION),
              eq(walletPositionLifecycles.lifecycleEpisode, row.lifecycleEpisode)
            )
          )
          .returning({ id: walletPositionLifecycles.id })
      )
    );
    staleLifecycleRowsDeleted += removed.length;
  }

  const persistedRowsAfter = await loadPersistedLifecycleRows(walletAddress);
  const lifecycleRowsAfter = persistedRowsAfter.length;
  const lifecycleParityAudit = auditLifecycleParity(allPositions, persistedRowsAfter);
  const lifecycleParity =
    lifecycleParityAudit.exactParity &&
    lifecycleRowsAfter === allPositions.length;

  return {
    lifecycleMode: "full",
    lifecyclesAffected: allPositions.length,
    lifecyclesInserted,
    lifecyclesUpdated,
    lifecyclesUnchanged: writes.filter((entry) => entry.action === "unchanged").length,
    lifecycleWriteMs: Date.now() - started,
    lifecycleRowsBefore,
    lifecycleRowsUpserted: lifecyclesInserted + lifecyclesUpdated,
    staleLifecycleRowsDeleted,
    lifecycleRowsAfter,
    replayLifecycleEpisodeCount: allPositions.length,
    lifecycleParity,
    lifecycleParityAudit,
  };
}

export async function upsertWalletPositionLifecyclesIncremental(
  wallet: string,
  allPositions: PositionLifecycle[],
  input: {
    novelEvents: WalletLedgerEvent[];
    allEvents: WalletLedgerEvent[];
    abortSignal?: AbortSignal;
  }
): Promise<LifecyclePersistStats> {
  const started = Date.now();
  const walletAddress = wallet.toLowerCase();
  assertPersistenceNotAborted(input.abortSignal, "lifecycle-persist-load");
  const persistedRows = await withDbCircuit("loadPersistedLifecycleRows", () =>
    withDbQueryTimeout("loadPersistedLifecycleRows", () =>
      loadPersistedLifecycleRows(walletAddress)
    )
  );
  const plan = planIncrementalLifecycleWrites({
    allPositions,
    novelEvents: input.novelEvents,
    allEvents: input.allEvents,
    persistedRows,
  });

  if (plan.lifecycleMode === "incremental" && plan.affectedKeys.size > 0) {
    await deleteStaleLifecycleEpisodes(
      walletAddress,
      plan.affectedKeys,
      allPositions
    );
  }

  let lifecyclesInserted = 0;
  let lifecyclesUpdated = 0;

  const toWrite = plan.writes.filter((w) => w.action !== "unchanged");
  const total = toWrite.length;
  let persisted = 0;
  let lastLogAt = started;
  let lastSuccessfulBatchAt = new Date(started).toISOString();
  const batches = planLifecycleWriteBatches(plan.writes);

  for (const batch of batches) {
    assertPersistenceNotAborted(input.abortSignal, "lifecycle-persist");
    await upsertLifecycleWriteBatch(walletAddress, batch);
    for (const entry of batch) {
      if (entry.action === "insert") lifecyclesInserted += 1;
      else lifecyclesUpdated += 1;
    }
    persisted += batch.length;
    lastSuccessfulBatchAt = new Date().toISOString();
    const now = Date.now();
    const rowMilestone =
      persisted % LIFECYCLE_PROGRESS_ROW_INTERVAL === 0 ||
      persisted === total;
    const timeMilestone = now - lastLogAt >= LIFECYCLE_PROGRESS_TIME_MS;
    if (rowMilestone || timeMilestone) {
      logLifecyclePersistProgress({
        wallet,
        persisted,
        total,
        startedAt: started,
        lastSuccessfulBatchAt,
      });
      lastLogAt = now;
    }
  }

  const lifecyclesUnchanged = plan.writes.filter((w) => w.action === "unchanged").length;

  return {
    lifecycleMode: plan.lifecycleMode,
    lifecyclesAffected: plan.affectedKeys.size,
    lifecyclesInserted,
    lifecyclesUpdated,
    lifecyclesUnchanged,
    lifecycleWriteMs: Date.now() - started,
  };
}

/** Re-export for tests that build keys from raw events. */
export function eventPositionKey(event: WalletLedgerEvent): string {
  return positionKey(event);
}
