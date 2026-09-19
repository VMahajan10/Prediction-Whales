import { createHash } from "node:crypto";
import {
  assignChainEventDedupeKey,
  authoritativeEventMergeKey,
} from "@/lib/walletLedger/canonicalChainIdentity";
import { sortLedgerEventsCanonical } from "@/lib/walletLedger/eventOrder";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

/**
 * Stable fingerprint for one event in the exact ordered lifecycle replay sequence.
 * Uses canonical merge identity (not legacy dedupe_key alone) plus economic fields
 * consumed by lifecycle reconstruction.
 */
export function lifecycleSequenceEventFingerprint(
  event: WalletLedgerEvent
): string {
  const normalized = assignChainEventDedupeKey(event);
  const mergeKey = authoritativeEventMergeKey(normalized);
  return [
    mergeKey,
    normalized.blockNumber ?? "",
    normalized.logIndex ?? "",
    normalized.type,
    normalized.asset ?? "",
    normalized.shares?.toFixed(6) ?? "",
    normalized.cashUsd?.toFixed(6) ?? "",
    normalized.conditionId ?? "",
  ].join("|");
}

/** @deprecated Prefer lifecycleSequenceEventFingerprint — keyed on legacy dedupeKey. */
export function lifecycleEventIdentityLegacy(event: WalletLedgerEvent): string {
  return [
    event.source,
    event.dedupeKey,
    event.type,
    event.conditionId ?? "",
    event.asset ?? "",
    event.txHash ?? "",
    event.logIndex ?? "",
    event.blockNumber ?? "",
    event.timestamp,
    event.shares?.toFixed(6) ?? "",
    event.cashUsd?.toFixed(6) ?? "",
  ].join("|");
}

/**
 * Hash of the EXACT ordered lifecycle input sequence (multiplicity counts).
 * Events are sorted with canonical ledger order before hashing.
 */
export function hashLifecycleInputSequence(events: WalletLedgerEvent[]): {
  count: number;
  hash: string;
} {
  const ordered = sortLedgerEventsCanonical(events);
  const fingerprints = ordered.map(lifecycleSequenceEventFingerprint);
  return {
    count: ordered.length,
    hash: createHash("sha256").update(fingerprints.join("\n")).digest("hex"),
  };
}

/**
 * Legacy lifecycle hash keyed primarily on dedupeKey lines (still multiplicity-aware
 * but blind to canonical identity when legacy dedupe_key differs).
 */
export function hashLifecycleInputLegacy(events: WalletLedgerEvent[]): {
  count: number;
  hash: string;
} {
  const ordered = sortLedgerEventsCanonical(events);
  const identities = ordered.map(lifecycleEventIdentityLegacy);
  return {
    count: ordered.length,
    hash: createHash("sha256").update(identities.join("\n")).digest("hex"),
  };
}
