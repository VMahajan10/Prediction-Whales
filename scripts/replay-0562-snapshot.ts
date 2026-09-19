#!/usr/bin/env tsx
import "../tests/preload-env";
import { filterChainAuthoritativeEvents } from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import {
  compareReplayToSnapshot,
  loadValidationSnapshot,
  replayMetricsFromValidationSnapshot,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";

const WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";
const SNAPSHOT =
  process.env.SNAPSHOT_PATH ??
  ".cache/wallet-validation-snapshots/0x0562e01b3c3e65bb93bf0de32f02cec238a79d66-0x0562e01b3c3e65bb93bf0de32f02cec238a79d66-mu28o1n7.json";

async function main(): Promise<void> {
  const snapshot = await loadValidationSnapshot(SNAPSHOT);
  const persistedChain = filterChainAuthoritativeEvents(
    await loadPersistedWalletEvents(WALLET)
  );
  const replay = await replayMetricsFromValidationSnapshot(snapshot, {
    chainEventsOverride: persistedChain,
    frozen: true,
  });
  const comparison = compareReplayToSnapshot(snapshot, replay);
  console.log(
    JSON.stringify(
      {
        persistedChainCount: persistedChain.length,
        snapshotAuthoritativeCount: snapshot.authoritativeEvents.length,
        exactMatch: comparison.exactMatch,
        completedDelta: comparison.completedDelta,
        policyAMatch: comparison.policyAMatch,
        lifecycleHashMatch:
          replay.replayLifecycleInputHash === snapshot.auditLifecycleInputHash,
        auditLifecycleInputHash: snapshot.auditLifecycleInputHash,
        replayLifecycleInputHash: replay.replayLifecycleInputHash,
        inputMismatch: replay.inputMismatch,
        inputMismatchReason: replay.inputMismatchReason,
      },
      null,
      2
    )
  );
}

void main();
