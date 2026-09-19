#!/usr/bin/env tsx
/**
 * Read-only interim Stage C calibration snapshot.
 * Does not finalize the batch or alter wallet decisions.
 */
import "./preload-env";
import { buildStageCInterimReport } from "@/lib/walletLedger/indexed/shadow/stageCInterimAnalysis";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

function parseArgs(argv: string[]): { batchId: string; since?: string } {
  let batchId = STAGE_C_BATCH_ID;
  let since: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--batch-id" && argv[i + 1]) {
      batchId = argv[++i]!;
    } else if (arg === "--since" && argv[i + 1]) {
      since = argv[++i]!;
    }
  }
  return { batchId, since };
}

async function main(): Promise<void> {
  const { batchId, since } = parseArgs(process.argv.slice(2));
  const report = await buildStageCInterimReport({ batchId, sinceIso: since });
  console.log(JSON.stringify(report, null, 2));
}

void main();
