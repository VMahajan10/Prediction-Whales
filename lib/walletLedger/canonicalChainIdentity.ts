import { createHash } from "node:crypto";
import { buildLedgerEventDedupeKey } from "@/lib/walletLedger/normalize";
import type {
  WalletLedgerEvent,
  WalletLedgerEventType,
} from "@/lib/walletLedger/types";

export const POLYGON_CHAIN_ID = "137";

/** Immutable chain-log identity classes for authoritative events. */
export type ChainEventIdentityClass =
  | "canonical_chain_log"
  | "recoverable_chain_log"
  | "synthetic_non_log"
  | "unresolved_chain_log";

export interface CanonicalIdentityDiagnostics {
  className: ChainEventIdentityClass;
  identity: string;
}

export interface IdentityCollapseGroup {
  canonicalIdentity: string;
  legacyDedupeKeys: string[];
  timestamps: number[];
  events: WalletLedgerEvent[];
  ledgerFieldConflicts: string[];
}

function roundKeyNumber(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return value.toFixed(6);
}

/**
 * Canonical immutable identity for an EVM chain log.
 * Format: chain:{chainId}|{txHash}|{logIndex}[|{contractAddress}]
 */
export function buildCanonicalChainLogIdentity(input: {
  chainId?: string;
  txHash: string;
  logIndex: number;
  contractAddress?: string;
}): string {
  const txHash = input.txHash.toLowerCase();
  const parts = [
    "chain",
    input.chainId ?? POLYGON_CHAIN_ID,
    txHash,
    String(input.logIndex),
  ];
  if (input.contractAddress?.trim()) {
    parts.push(input.contractAddress.toLowerCase());
  }
  return parts.join("|");
}

/**
 * Explicit synthetic identity for authoritative events without chain-log coordinates.
 * Does not use timestamp or other mutable enrichment fields.
 */
export function buildSyntheticAuthoritativeIdentity(input: {
  wallet: string;
  type: WalletLedgerEventType;
  txHash?: string;
  asset?: string;
  conditionId?: string;
  shares?: number;
  cashUsd?: number;
  blockNumber?: number;
}): string {
  return [
    "synthetic",
    input.wallet.toLowerCase(),
    input.type,
    (input.txHash ?? "").toLowerCase(),
    input.conditionId ?? "",
    input.asset ?? "",
    input.blockNumber != null && input.blockNumber > 0
      ? String(input.blockNumber)
      : "",
    roundKeyNumber(input.shares),
    roundKeyNumber(input.cashUsd),
  ].join("|");
}

export function hasCanonicalChainLogCoordinates(
  event: Pick<WalletLedgerEvent, "txHash" | "logIndex">
): boolean {
  return (
    Boolean(event.txHash?.trim()) &&
    event.logIndex != null &&
    event.logIndex >= 0
  );
}

export function classifyChainEventIdentity(
  event: WalletLedgerEvent,
  opts?: {
    rawLogExistsForTx?: (txHash: string) => boolean;
    chainLogIndexLookup?: Map<string, number>;
  }
): ChainEventIdentityClass {
  if (event.source !== "polygon") {
    return "synthetic_non_log";
  }
  if (hasCanonicalChainLogCoordinates(event)) {
    return "canonical_chain_log";
  }

  const txHash = event.txHash?.trim();
  if (!txHash || (event.blockNumber ?? 0) <= 0) {
    return "synthetic_non_log";
  }

  if (opts?.chainLogIndexLookup) {
    const coordinateKey = `${txHash.toLowerCase()}|${event.blockNumber}`;
    const candidates = [...opts.chainLogIndexLookup.entries()].filter(([key]) =>
      key.startsWith(`${txHash.toLowerCase()}|`)
    );
    if (candidates.length > 0) {
      return "recoverable_chain_log";
    }
  }

  if (opts?.rawLogExistsForTx?.(txHash)) {
    return "recoverable_chain_log";
  }

  return "unresolved_chain_log";
}

/**
 * Resolve the authoritative identity for a chain event.
 * Returns null only for unresolved chain logs that cannot be keyed without timestamp.
 */
export function resolveAuthoritativeChainIdentity(
  event: WalletLedgerEvent,
  chainId = POLYGON_CHAIN_ID
): string | null {
  const className = classifyChainEventIdentity(event);
  if (className === "canonical_chain_log") {
    return buildCanonicalChainLogIdentity({
      chainId,
      txHash: event.txHash!,
      logIndex: event.logIndex!,
      contractAddress: undefined,
    });
  }
  if (className === "unresolved_chain_log") {
    return null;
  }
  if (className === "recoverable_chain_log") {
    return null;
  }
  return buildSyntheticAuthoritativeIdentity({
    wallet: event.wallet,
    type: event.type,
    txHash: event.txHash,
    asset: event.asset,
    conditionId: event.conditionId,
    shares: event.shares,
    cashUsd: event.cashUsd,
    blockNumber: event.blockNumber,
  });
}

export function authoritativeEventMergeKey(
  event: WalletLedgerEvent,
  chainId = POLYGON_CHAIN_ID
): string {
  if (event.source === "polygon") {
    const canonical = resolveAuthoritativeChainIdentity(event, chainId);
    if (canonical) return canonical;
    return buildSyntheticAuthoritativeIdentity({
      wallet: event.wallet,
      type: event.type,
      txHash: event.txHash,
      asset: event.asset,
      conditionId: event.conditionId,
      shares: event.shares,
      cashUsd: event.cashUsd,
      blockNumber: event.blockNumber,
    });
  }
  return event.dedupeKey;
}

/**
 * Assign canonical dedupeKey for polygon chain events at normalization time.
 * API/trades events keep timestamp-bearing dedupe keys.
 */
export function assignChainEventDedupeKey(
  event: WalletLedgerEvent,
  chainId = POLYGON_CHAIN_ID
): WalletLedgerEvent {
  if (event.source !== "polygon") {
    return event;
  }
  if (hasCanonicalChainLogCoordinates(event)) {
    return {
      ...event,
      dedupeKey: buildCanonicalChainLogIdentity({
        chainId,
        txHash: event.txHash!,
        logIndex: event.logIndex!,
      }),
    };
  }
  const synthetic = buildSyntheticAuthoritativeIdentity({
    wallet: event.wallet,
    type: event.type,
    txHash: event.txHash,
    asset: event.asset,
    conditionId: event.conditionId,
    shares: event.shares,
    cashUsd: event.cashUsd,
    blockNumber: event.blockNumber,
  });
  return { ...event, dedupeKey: synthetic };
}

export function buildApiEventDedupeKey(input: {
  txHash?: string;
  asset?: string;
  conditionId?: string;
  timestamp?: number;
  type: WalletLedgerEventType;
  side?: string;
  shares?: number;
  price?: number;
  cashUsd?: number;
}): string {
  return buildLedgerEventDedupeKey(input);
}

export function ledgerFieldConflicts(
  left: WalletLedgerEvent,
  right: WalletLedgerEvent
): string[] {
  const conflicts: string[] = [];
  if (left.wallet.toLowerCase() !== right.wallet.toLowerCase()) {
    conflicts.push("wallet");
  }
  if (left.type !== right.type) conflicts.push("type");
  if (left.asset && right.asset && left.asset !== right.asset) {
    conflicts.push("asset");
  }
  if (
    left.conditionId &&
    right.conditionId &&
    left.conditionId !== right.conditionId
  ) {
    conflicts.push("conditionId");
  }
  if (
    left.blockNumber &&
    right.blockNumber &&
    left.blockNumber !== right.blockNumber
  ) {
    conflicts.push("blockNumber");
  }
  if (
    left.txHash &&
    right.txHash &&
    left.txHash.toLowerCase() !== right.txHash.toLowerCase()
  ) {
    conflicts.push("txHash");
  }
  if (
    left.logIndex != null &&
    right.logIndex != null &&
    left.logIndex !== right.logIndex
  ) {
    conflicts.push("logIndex");
  }
  if (
    left.shares != null &&
    right.shares != null &&
    roundKeyNumber(left.shares) !== roundKeyNumber(right.shares)
  ) {
    conflicts.push("shares");
  }
  if (
    left.cashUsd != null &&
    right.cashUsd != null &&
    roundKeyNumber(left.cashUsd) !== roundKeyNumber(right.cashUsd)
  ) {
    conflicts.push("cashUsd");
  }
  return conflicts;
}

function physicalChainLogGroupKey(
  event: WalletLedgerEvent,
  chainId = POLYGON_CHAIN_ID
): string | null {
  if (event.source !== "polygon" || !event.txHash?.trim()) return null;
  if (hasCanonicalChainLogCoordinates(event)) {
    return buildCanonicalChainLogIdentity({
      chainId,
      txHash: event.txHash,
      logIndex: event.logIndex!,
    });
  }
  return null;
}

export function collapseEventsByCanonicalIdentity(
  events: WalletLedgerEvent[],
  chainId = POLYGON_CHAIN_ID
): {
  collapsed: WalletLedgerEvent[];
  groups: IdentityCollapseGroup[];
  unresolved: WalletLedgerEvent[];
} {
  const byCanonical = new Map<string, WalletLedgerEvent[]>();
  const unresolved: WalletLedgerEvent[] = [];
  const logIndexByTx = new Map<string, number>();
  for (const event of events) {
    if (!hasCanonicalChainLogCoordinates(event) || !event.txHash) continue;
    logIndexByTx.set(
      `${event.txHash.toLowerCase()}|${event.logIndex}`,
      event.logIndex!
    );
  }

  for (const event of events) {
    if (event.source !== "polygon") continue;
    const physicalKey = physicalChainLogGroupKey(event, chainId);
    let key = physicalKey;
    if (!key && isLegacyTimestampBearingChainDedupeKey(event.dedupeKey)) {
      key = `legacy-neutral:${legacyTimestampNeutralDedupeKey(event.dedupeKey)}`;
    }
    if (!key) {
      key =
        classifyChainEventIdentity(event) === "unresolved_chain_log"
          ? null
          : authoritativeEventMergeKey(event, chainId);
    }
    if (!key) {
      unresolved.push(event);
      continue;
    }
    const list = byCanonical.get(key) ?? [];
    list.push(event);
    byCanonical.set(key, list);
  }

  const groups: IdentityCollapseGroup[] = [];
  const collapsed: WalletLedgerEvent[] = [];

  for (const [canonicalIdentity, group] of byCanonical.entries()) {
    const legacyDedupeKeys = [...new Set(group.map((event) => event.dedupeKey))];
    const timestamps = [...new Set(group.map((event) => event.timestamp))];
    const ledgerFieldConflictsSet = new Set<string>();
    for (let i = 1; i < group.length; i += 1) {
      for (const field of ledgerFieldConflicts(group[0], group[i])) {
        ledgerFieldConflictsSet.add(field);
      }
    }
    groups.push({
      canonicalIdentity,
      legacyDedupeKeys,
      timestamps,
      events: group,
      ledgerFieldConflicts: [...ledgerFieldConflictsSet],
    });
    const primary = group.find((event) => event.timestamp > 0) ?? group[0];
    collapsed.push(
      assignChainEventDedupeKey(
        {
          ...primary,
          dedupeKey: canonicalIdentity,
        },
        chainId
      )
    );
  }

  return { collapsed, groups, unresolved };
}

export function hashCanonicalAuthoritativeIdentities(
  events: WalletLedgerEvent[],
  chainId = POLYGON_CHAIN_ID
): string {
  const keys = events
    .filter((event) => event.source === "polygon")
    .map((event) => authoritativeEventMergeKey(event, chainId))
    .sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

export function countUniqueLegacyVsCanonicalIdentities(
  events: WalletLedgerEvent[],
  chainId = POLYGON_CHAIN_ID
): {
  legacyIdentityCount: number;
  canonicalIdentityCount: number;
  collapsedDuplicateGroups: number;
  collapsedPhysicalLogs: number;
  timestampZeroVsValidGroups: number;
  ledgerFieldConflictGroups: number;
  groups: IdentityCollapseGroup[];
  unresolvedCount: number;
} {
  const polygon = events.filter((event) => event.source === "polygon");
  const legacyKeys = new Set(polygon.map((event) => event.dedupeKey));
  const { collapsed, groups, unresolved } = collapseEventsByCanonicalIdentity(
    polygon,
    chainId
  );
  const canonicalKeys = new Set(
    collapsed.map((event) => authoritativeEventMergeKey(event, chainId))
  );

  let collapsedDuplicateGroups = 0;
  let collapsedPhysicalLogs = 0;
  let timestampZeroVsValidGroups = 0;
  let ledgerFieldConflictGroups = 0;

  for (const group of groups) {
    if (group.legacyDedupeKeys.length > 1) {
      collapsedDuplicateGroups += 1;
      collapsedPhysicalLogs += group.legacyDedupeKeys.length - 1;
    }
    const hasZero = group.timestamps.some((ts) => ts <= 0);
    const hasValid = group.timestamps.some((ts) => ts > 0);
    if (hasZero && hasValid) {
      timestampZeroVsValidGroups += 1;
    }
    if (group.ledgerFieldConflicts.length > 0) {
      ledgerFieldConflictGroups += 1;
    }
  }

  return {
    legacyIdentityCount: legacyKeys.size,
    canonicalIdentityCount: canonicalKeys.size,
    collapsedDuplicateGroups,
    collapsedPhysicalLogs,
    timestampZeroVsValidGroups,
    ledgerFieldConflictGroups,
    groups,
    unresolvedCount: unresolved.length,
  };
}

/** @deprecated Use hashCanonicalAuthoritativeIdentities for authoritative chain sets. */
export function legacyTimestampNeutralDedupeKey(dedupeKey: string): string {
  const parts = dedupeKey.split("|");
  if (parts.length < 4) return dedupeKey;
  parts[3] = "*";
  return parts.join("|");
}

export function dedupeKeyHasTimestampZero(dedupeKey: string): boolean {
  const parts = dedupeKey.split("|");
  return parts.length >= 4 && parts[3] === "0";
}

export function isLegacyTimestampBearingChainDedupeKey(dedupeKey: string): boolean {
  if (dedupeKey.startsWith("chain|") || dedupeKey.startsWith("synthetic|")) {
    return false;
  }
  const parts = dedupeKey.split("|");
  if (parts.length < 4) return false;
  const timestampPart = parts[3];
  return /^\d+$/.test(timestampPart);
}
