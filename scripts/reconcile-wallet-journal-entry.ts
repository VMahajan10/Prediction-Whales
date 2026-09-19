#!/usr/bin/env tsx
import "./preload-env";
import {
  readBatchStatusJournal,
  upsertBatchStatusSafe,
} from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";

const wallet = (process.argv[2] ?? "").toLowerCase();
const batchId = process.argv[3] ?? "phase2e2-stageC-v1";

if (!wallet) {
  throw new Error("wallet address required");
}

const entry = readBatchStatusJournal()
  .filter((row) => row.wallet === wallet && row.batchId === batchId)
  .at(-1);

if (!entry) {
  console.error(JSON.stringify({ wallet, batchId, found: false }));
  process.exit(1);
}

async function main(): Promise<void> {
  const result = await upsertBatchStatusSafe({
    batchId: entry.batchId,
    wallet: entry.wallet,
    status: entry.desiredStatus,
    cohortReason: entry.cohortReason,
    errorMessage: entry.errorMessage ?? "Etherscan fetch aborted",
    performance: entry.performance,
  });

  console.log(JSON.stringify({ wallet, batchId, entry, result }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
