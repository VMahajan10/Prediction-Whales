import { describe, expect, it } from "vitest";
import {
  assignChainEventDedupeKey,
  authoritativeEventMergeKey,
  buildCanonicalChainLogIdentity,
  countUniqueLegacyVsCanonicalIdentities,
  hashCanonicalAuthoritativeIdentities,
  legacyTimestampNeutralDedupeKey,
} from "@/lib/walletLedger/canonicalChainIdentity";
import { buildAuthoritativeCoverageFingerprint } from "@/lib/walletLedger/indexed/store/authoritativeCoverageFingerprint";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function chainEvent(input: {
  txHash: string;
  logIndex: number;
  timestamp: number;
  asset?: string;
  type?: WalletLedgerEvent["type"];
  shares?: number;
}): WalletLedgerEvent {
  return assignChainEventDedupeKey({
    wallet: "0xwallet",
    conditionId: "",
    asset: input.asset ?? "asset-1",
    timestamp: input.timestamp,
    type: input.type ?? "BUY",
    shares: input.shares ?? 10,
    cashUsd: 5,
    price: 0.5,
    txHash: input.txHash,
    blockNumber: 100,
    logIndex: input.logIndex,
    source: "polygon",
    dedupeKey: "",
  });
}

describe("canonicalChainIdentity", () => {
  it("A: same txHash/logIndex with timestamp=0 vs valid share canonical identity", () => {
    const zeroTs = chainEvent({
      txHash: "0xabc",
      logIndex: 7,
      timestamp: 0,
    });
    const validTs = chainEvent({
      txHash: "0xabc",
      logIndex: 7,
      timestamp: 1_700_000_000,
    });
    expect(zeroTs.dedupeKey).toBe(validTs.dedupeKey);
    expect(zeroTs.dedupeKey).toBe(
      buildCanonicalChainLogIdentity({ txHash: "0xabc", logIndex: 7 })
    );
  });

  it("B: timestamp enrichment does not change coverage fingerprint", () => {
    const before = chainEvent({
      txHash: "0xabc",
      logIndex: 1,
      timestamp: 0,
    });
    const after = { ...before, timestamp: 1_800_000_000 };
    const fpBefore = buildAuthoritativeCoverageFingerprint({
      wallet: "0xwallet",
      provider: "etherscan_v2",
      perContractFromBlock: {},
      throughBlock: 100,
      querySubjects: ["0xwallet"],
      authoritativeEvents: [before],
    });
    const fpAfter = buildAuthoritativeCoverageFingerprint({
      wallet: "0xwallet",
      provider: "etherscan_v2",
      perContractFromBlock: {},
      throughBlock: 100,
      querySubjects: ["0xwallet"],
      authoritativeEvents: [after],
    });
    expect(fpBefore.authoritativeIdentityHash).toBe(
      fpAfter.authoritativeIdentityHash
    );
    expect(fpBefore.fingerprintHash).toBe(fpAfter.fingerprintHash);
  });

  it("C: same txHash but different logIndex are distinct", () => {
    const a = chainEvent({ txHash: "0xabc", logIndex: 1, timestamp: 1 });
    const b = chainEvent({ txHash: "0xabc", logIndex: 2, timestamp: 1 });
    expect(authoritativeEventMergeKey(a)).not.toBe(authoritativeEventMergeKey(b));
  });

  it("D: same block/asset/side but different physical logs stay distinct", () => {
    const a = chainEvent({
      txHash: "0xabc",
      logIndex: 1,
      timestamp: 1,
      asset: "asset-yes",
      shares: 10,
    });
    const b = chainEvent({
      txHash: "0xdef",
      logIndex: 2,
      timestamp: 1,
      asset: "asset-yes",
      shares: 10,
    });
    expect(authoritativeEventMergeKey(a)).not.toBe(authoritativeEventMergeKey(b));
  });

  it("E: cold vs resumed identical physical logs share canonical hash", () => {
    const cold = [
      chainEvent({ txHash: "0x1", logIndex: 1, timestamp: 0 }),
      chainEvent({ txHash: "0x2", logIndex: 3, timestamp: 0 }),
    ];
    const resumed = [
      chainEvent({ txHash: "0x1", logIndex: 1, timestamp: 1_700_000_000 }),
      chainEvent({ txHash: "0x2", logIndex: 3, timestamp: 1_700_000_100 }),
    ];
    expect(hashCanonicalAuthoritativeIdentities(cold)).toBe(
      hashCanonicalAuthoritativeIdentities(resumed)
    );
  });

  it("F: metadata enrichment cannot create a new authoritative identity", () => {
    const legacyKey =
      "0xabc||asset-1|0|BUY|BUY|10.000000|0.500000|5.000000";
    const enriched = chainEvent({
      txHash: "0xabc",
      logIndex: 4,
      timestamp: 1_900_000_000,
    });
    enriched.dedupeKey = legacyKey;
    const collapsed = countUniqueLegacyVsCanonicalIdentities([
      chainEvent({ txHash: "0xabc", logIndex: 4, timestamp: 0 }),
      enriched,
    ]);
    expect(collapsed.canonicalIdentityCount).toBe(1);
    expect(collapsed.ledgerFieldConflictGroups).toBe(0);
    expect(legacyTimestampNeutralDedupeKey(legacyKey)).toContain("|*|");
  });
});
