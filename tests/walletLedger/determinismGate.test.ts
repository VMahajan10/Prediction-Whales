import { describe, expect, it } from "vitest";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { buildAuthoritativeCoverageFingerprint } from "@/lib/walletLedger/indexed/store/authoritativeCoverageFingerprint";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function chainEvent(
  dedupeKey: string,
  blockNumber: number,
  logIndex: number
): WalletLedgerEvent {
  return {
    wallet: "0xwallet",
    conditionId: "cond-a",
    asset: "asset-yes",
    timestamp: 1_700_000_000 + blockNumber,
    type: "BUY",
    shares: 10,
    cashUsd: 5,
    price: 0.5,
    dedupeKey,
    source: "polygon",
    blockNumber,
    logIndex,
    txHash: `0xtx${blockNumber}`,
  };
}

describe("determinism gate helpers", () => {
  it("buildPositionLifecycles is independent of input event order", async () => {
    const events = [
      chainEvent("a", 100, 1),
      chainEvent("b", 101, 2),
      chainEvent("c", 102, 3),
    ];
    const shuffled = [events[2], events[0], events[1]];
    const first = await buildPositionLifecycles("0xwallet", events);
    const second = await buildPositionLifecycles("0xwallet", shuffled);
    expect(first.positions.map((p) => p.lifecycleEpisode)).toEqual(
      second.positions.map((p) => p.lifecycleEpisode)
    );
    expect(first.positions.length).toBe(second.positions.length);
  });

  it("coverage fingerprint changes when authoritative identity hash changes", () => {
    const base = buildAuthoritativeCoverageFingerprint({
      wallet: "0xabc",
      provider: "etherscan_v2",
      perContractFromBlock: { "0xcontract": 1_000 },
      throughBlock: 2_000,
      querySubjects: ["0xabc"],
      authoritativeEvents: [chainEvent("k1", 100, 1)],
    });
    const changed = buildAuthoritativeCoverageFingerprint({
      wallet: "0xabc",
      provider: "etherscan_v2",
      perContractFromBlock: { "0xcontract": 1_000 },
      throughBlock: 2_000,
      querySubjects: ["0xabc"],
      authoritativeEvents: [chainEvent("k2", 101, 2)],
    });
    expect(base.fingerprintHash).not.toBe(changed.fingerprintHash);
  });
});
