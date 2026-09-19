#!/usr/bin/env tsx
/**
 * Read-only audit + validation snapshot write for pilot wallets.
 * Does NOT persist Policy A metrics or hydrate new wallets.
 */
import "../tests/preload-env";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import {
  buildValidationSnapshotFromAudit,
  compareReplayToSnapshot,
  replayMetricsFromValidationSnapshot,
  saveValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";

const DEFAULT_WALLETS = [
  "0x4f29e103339919c4baaea2a60195cf1c8bb27a7e",
  "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6",
];

async function refreshWallet(wallet: string) {
  const audit = await runIndexedWalletAudit({
    label: `snapshot-refresh-${wallet.slice(0, 8)}`,
    wallet,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: true,
    allowEarlierThanIncremental: true,
  });
  const apiEvents = audit.apiEvents ?? [];
  if (apiEvents.length === 0) {
    throw new Error(
      `audit.apiEvents missing for ${wallet}; cannot build exact replay snapshot`
    );
  }
  const gammaCacheEntries = audit.gammaCacheEntries ?? [];
  const snapshot = buildValidationSnapshotFromAudit(audit, {
    apiEvents,
    gammaCacheEntries,
  });
  const replay = await replayMetricsFromValidationSnapshot(snapshot, {
    frozen: true,
  });
  const comparison = compareReplayToSnapshot(snapshot, replay);
  if (!comparison.exactMatch) {
    throw new Error(
      `snapshot replay mismatch for ${wallet}: completedDelta=${comparison.completedDelta} lifecycleKeys=${comparison.lifecycleEpisodeKeysMatch}`
    );
  }
  const path = await saveValidationSnapshot(snapshot);
  return {
    wallet,
    snapshotPath: path,
    throughBlock: snapshot.throughBlock,
    authoritativeEventCount: snapshot.authoritativeEventCount,
    authoritativeEventIdentityHash: snapshot.authoritativeEventIdentityHash,
    metricComputationInputHash: snapshot.metricComputationInputHash,
    auditLifecycleInputHash: snapshot.auditLifecycleInputHash,
    auditMetrics: snapshot.auditMetrics,
    replayMetrics: replay.metrics,
    exactReplay: comparison.exactMatch,
  };
}

async function main() {
  const wallets =
    process.env.ONLY_WALLET != null
      ? [process.env.ONLY_WALLET.toLowerCase()]
      : DEFAULT_WALLETS;
  const results = [];
  for (const wallet of wallets) {
    console.error(`[snapshot-refresh] wallet=${wallet}`);
    results.push(await refreshWallet(wallet));
  }
  console.log(JSON.stringify({ mode: "snapshot_refresh", results }, null, 2));
}

void main().catch((error) => {
  console.error("[refresh-pilot-validation-snapshots] failed:", error);
  process.exit(1);
});
