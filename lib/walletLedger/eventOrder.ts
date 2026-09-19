import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export interface CanonicalOrderDiagnostics {
  total: number;
  withFullChainOrder: number;
  withBlockOnly: number;
  withoutChainOrder: number;
}

function preferDefinedNonNegative(
  primary: number | undefined,
  secondary: number | undefined
): number | undefined {
  if (primary != null && primary >= 0) return primary;
  if (secondary != null && secondary >= 0) return secondary;
  return undefined;
}

export function hasFullCanonicalChainOrder(event: WalletLedgerEvent): boolean {
  return (
    event.blockNumber != null &&
    event.blockNumber > 0 &&
    event.logIndex != null &&
    event.logIndex >= 0
  );
}

export function hasPartialCanonicalChainOrder(event: WalletLedgerEvent): boolean {
  return event.blockNumber != null && event.blockNumber > 0;
}

/**
 * Canonical replay order: blockNumber → logIndex → transactionIndex → dedupeKey.
 * Timestamp is used only when authoritative chain coordinates are unavailable.
 * timestamp=0/null never sorts before events with valid chain coordinates.
 */
export function compareLedgerEventsCanonical(
  a: WalletLedgerEvent,
  b: WalletLedgerEvent
): number {
  const aBlock = a.blockNumber ?? 0;
  const bBlock = b.blockNumber ?? 0;
  const aHasBlock = aBlock > 0;
  const bHasBlock = bBlock > 0;

  if (aHasBlock && bHasBlock) {
    if (aBlock !== bBlock) return aBlock - bBlock;
    const aLog = a.logIndex;
    const bLog = b.logIndex;
    if (aLog != null && bLog != null && aLog !== bLog) {
      return aLog - bLog;
    }
    const aTx = a.transactionIndex;
    const bTx = b.transactionIndex;
    if (
      (aLog == null || bLog == null) &&
      aTx != null &&
      bTx != null &&
      aTx !== bTx
    ) {
      return aTx - bTx;
    }
    return a.dedupeKey.localeCompare(b.dedupeKey);
  }

  if (aHasBlock && !bHasBlock) return -1;
  if (!aHasBlock && bHasBlock) return 1;

  const aTs = a.timestamp > 0 ? a.timestamp : Number.MAX_SAFE_INTEGER;
  const bTs = b.timestamp > 0 ? b.timestamp : Number.MAX_SAFE_INTEGER;
  if (aTs !== bTs) return aTs - bTs;
  return a.dedupeKey.localeCompare(b.dedupeKey);
}

export function sortLedgerEventsCanonical(
  events: WalletLedgerEvent[]
): WalletLedgerEvent[] {
  return [...events].sort(compareLedgerEventsCanonical);
}

export function summarizeCanonicalOrderDiagnostics(
  events: WalletLedgerEvent[]
): CanonicalOrderDiagnostics {
  let withFullChainOrder = 0;
  let withBlockOnly = 0;
  let withoutChainOrder = 0;
  for (const event of events) {
    if (hasFullCanonicalChainOrder(event)) {
      withFullChainOrder += 1;
    } else if (hasPartialCanonicalChainOrder(event)) {
      withBlockOnly += 1;
    } else {
      withoutChainOrder += 1;
    }
  }
  return {
    total: events.length,
    withFullChainOrder,
    withBlockOnly,
    withoutChainOrder,
  };
}

export function mergeChainOrderFields(
  primary: WalletLedgerEvent,
  secondary: WalletLedgerEvent
): Pick<WalletLedgerEvent, "blockNumber" | "logIndex" | "transactionIndex"> {
  return {
    blockNumber: preferDefinedNonNegative(
      primary.blockNumber,
      secondary.blockNumber
    ),
    logIndex: preferDefinedNonNegative(primary.logIndex, secondary.logIndex),
    transactionIndex: preferDefinedNonNegative(
      primary.transactionIndex,
      secondary.transactionIndex
    ),
  };
}
