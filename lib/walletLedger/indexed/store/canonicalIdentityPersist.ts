import {
  authoritativeEventMergeKey,
  assignChainEventDedupeKey,
  buildCanonicalChainLogIdentity,
} from "@/lib/walletLedger/canonicalChainIdentity";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

/** Canonical identity for genuine chain-log rows; null for API/synthetic rows. */
export function resolveChainLogCanonicalIdentityForPersist(
  event: WalletLedgerEvent
): string | null {
  if (event.source !== "polygon") return null;
  if (
    event.txHash &&
    event.logIndex != null &&
    event.logIndex >= 0
  ) {
    return buildCanonicalChainLogIdentity({
      txHash: event.txHash,
      logIndex: event.logIndex,
    });
  }
  return null;
}

export function persistedCanonicalMatchKey(
  event: WalletLedgerEvent
): string {
  return authoritativeEventMergeKey(assignChainEventDedupeKey(event));
}
