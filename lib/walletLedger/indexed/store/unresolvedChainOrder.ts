import {
  classifyChainEventIdentity,
  hasCanonicalChainLogCoordinates,
} from "@/lib/walletLedger/canonicalChainIdentity";
import {
  filterChainAuthoritativeEvents,
  isChainAuthoritativeEvent,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { prepareAuthoritativeEventsForLifecycleMerge } from "@/lib/walletLedger/indexed/store/validationSnapshot";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export interface UnresolvedChainOrderAssessment {
  unresolvedChainEvents: number;
  unresolvedChainEventsInLifecycle: number;
  affectedPositionGroups: number;
  blocksCredibility: boolean;
}

function positionGroupKey(event: WalletLedgerEvent): string {
  return [
    event.wallet.toLowerCase(),
    event.blockNumber ?? "",
    event.conditionId ?? "",
    event.asset ?? "",
  ].join("|");
}

/**
 * Fail closed: unresolved polygon chain logs in lifecycle block metrics-safe validity.
 */
export function assessUnresolvedChainOrder(
  chainEvents: WalletLedgerEvent[]
): UnresolvedChainOrderAssessment {
  const authoritative = filterChainAuthoritativeEvents(chainEvents);
  const lifecycleChain = prepareAuthoritativeEventsForLifecycleMerge(authoritative);

  const unresolvedInLifecycle = lifecycleChain.filter(
    (event) =>
      isChainAuthoritativeEvent(event) &&
      classifyChainEventIdentity(event) === "unresolved_chain_log"
  );

  const blockGroups = new Map<string, WalletLedgerEvent[]>();
  for (const event of unresolvedInLifecycle) {
    const block = event.blockNumber ?? 0;
    if (block <= 0) continue;
    const key = String(block);
    const list = blockGroups.get(key) ?? [];
    list.push(event);
    blockGroups.set(key, list);
  }

  let affectedPositionGroups = 0;
  for (const event of unresolvedInLifecycle) {
    const groupKey = positionGroupKey(event);
    const sameBlock = blockGroups.get(String(event.blockNumber ?? 0)) ?? [];
    const samePositionSameBlock = sameBlock.filter(
      (other) => positionGroupKey(other) === groupKey
    );
    if (samePositionSameBlock.length > 1) {
      affectedPositionGroups += 1;
    } else if (
      event.type === "BUY" ||
      event.type === "SELL" ||
      event.type === "MERGE" ||
      event.type === "SPLIT"
    ) {
      affectedPositionGroups += 1;
    }
  }

  const unresolvedChainEvents = authoritative.filter(
    (event) => classifyChainEventIdentity(event) === "unresolved_chain_log"
  ).length;

  const unresolvedChainEventsInLifecycle = unresolvedInLifecycle.length;

  return {
    unresolvedChainEvents,
    unresolvedChainEventsInLifecycle,
    affectedPositionGroups,
    blocksCredibility: unresolvedChainEventsInLifecycle > 0,
  };
}

export function countUnresolvedInLifecycle(
  chainEvents: WalletLedgerEvent[]
): number {
  return assessUnresolvedChainOrder(chainEvents).unresolvedChainEventsInLifecycle;
}

export function hasAuthoritativeIntraBlockOrder(event: WalletLedgerEvent): boolean {
  return hasCanonicalChainLogCoordinates(event);
}
