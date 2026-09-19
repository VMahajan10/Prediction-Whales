#!/usr/bin/env tsx
import "./preload-env";
import { reclassifyInfraFailedBatchStatuses } from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";

const batchId = process.argv[2] ?? "phase2e1-full50-v2";

async function main(): Promise<void> {
  const changed = await reclassifyInfraFailedBatchStatuses(batchId);
  console.log(JSON.stringify({ batchId, reclassified: changed }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
