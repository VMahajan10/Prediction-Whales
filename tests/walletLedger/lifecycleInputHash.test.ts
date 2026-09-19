import { describe, expect, it } from "vitest";
import {
  assignChainEventDedupeKey,
  authoritativeEventMergeKey,
} from "@/lib/walletLedger/canonicalChainIdentity";
import {
  hashLifecycleInputLegacy,
  hashLifecycleInputSequence,
  lifecycleSequenceEventFingerprint,
} from "@/lib/walletLedger/indexed/store/lifecycleInputHash";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function chainEvent(
  seed: string,
  logIndex: number,
  dedupeKeyOverride?: string
): WalletLedgerEvent {
  const base = assignChainEventDedupeKey({
    wallet: "0xwallet",
    conditionId: "cond",
    asset: `asset-${seed}`,
    timestamp: 1_700_000_000 + logIndex,
    type: "BUY",
    dedupeKey: "",
    source: "polygon",
    blockNumber: 100 + logIndex,
    logIndex,
    txHash: `0xtx${seed}`,
    shares: 10,
    cashUsd: 5,
  });
  if (!dedupeKeyOverride) return base;
  return { ...base, dedupeKey: dedupeKeyOverride };
}

describe("lifecycleInputHash", () => {
  it("A: duplicate physical events with different legacy dedupe keys change sequence hash vs deduped canonical audit", () => {
    const canonical = chainEvent("dup", 1);
    const legacyCopy = chainEvent(
      "dup",
      1,
      "legacy-timestamp-dedupe-key"
    );
    const deduped = [canonical];
    const duplicateReplay = [canonical, legacyCopy];
    const dedupedHash = hashLifecycleInputSequence(deduped).hash;
    const duplicateHash = hashLifecycleInputSequence(duplicateReplay).hash;
    expect(duplicateHash).not.toBe(dedupedHash);
    expect(
      lifecycleSequenceEventFingerprint(canonical)
    ).toBe(lifecycleSequenceEventFingerprint(legacyCopy));
  });

  it("B: same identity set but different multiplicity changes sequence hash", () => {
    const event = chainEvent("one", 2);
    const once = hashLifecycleInputSequence([event]).hash;
    const twice = hashLifecycleInputSequence([event, event]).hash;
    expect(once).not.toBe(twice);
  });

  it("C: different canonical lifecycle order changes sequence hash", () => {
    const earlier = chainEvent("a", 1);
    const later = chainEvent("b", 9);
    const forward = hashLifecycleInputSequence([earlier, later]).hash;
    const reverse = hashLifecycleInputSequence([later, earlier]).hash;
    expect(forward).toBe(reverse);
    const different = hashLifecycleInputSequence([later]).hash;
    expect(forward).not.toBe(different);
  });

  it("D: legacy hash can match while sequence hash differs for duplicate merge keys", () => {
    const canonical = chainEvent("dup", 3);
    const legacy = chainEvent("dup", 3, "legacy-key-3");
    const legacyHash = hashLifecycleInputLegacy([canonical, legacy]);
    const sequenceHash = hashLifecycleInputSequence([canonical, legacy]);
    expect(legacyHash.count).toBe(sequenceHash.count);
    expect(
      authoritativeEventMergeKey(canonical)
    ).toBe(authoritativeEventMergeKey(legacy));
  });
});
