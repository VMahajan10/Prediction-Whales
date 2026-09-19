#!/usr/bin/env tsx
/**
 * Canonical-v2 cold vs resume gate for 4f29 (read-only, no persist, no metrics).
 */
import "../tests/preload-env";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCanonicalV2ReconstructionReport,
  diffCanonicalV2Reports,
} from "@/lib/walletLedger/indexed/store/canonicalV2ReconstructionReport";
import { filterChainAuthoritativeEvents } from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { countWalletLedgerEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";

const WALLET = "0x4f29e103339919c4baaea2a60195cf1c8bb27a7e";
const OUTPUT = path.join(
  process.cwd(),
  ".cache",
  "4f29-canonical-v2-cold-resume.json"
);

async function main() {
  const persistedBefore = await countWalletLedgerEvents(WALLET);
  console.error(`[canonical-v2] persisted baseline rows=${persistedBefore}`);

  console.error("[canonical-v2] Run A: cold (no checkpoint adoption)");
  const coldAudit = await runIndexedWalletAudit({
    label: "canonical-v2-cold",
    wallet: WALLET,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: false,
    allowEarlierThanIncremental: true,
  });
  const coldReport = buildCanonicalV2ReconstructionReport({
    runLabel: "cold",
    audit: coldAudit,
    persistedBaselineEvents: persistedBefore,
  });

  console.error("[canonical-v2] Run B: checkpoint/resume");
  const resumedAudit = await runIndexedWalletAudit({
    label: "canonical-v2-resumed",
    wallet: WALLET,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: true,
    allowEarlierThanIncremental: true,
  });
  const resumedReport = buildCanonicalV2ReconstructionReport({
    runLabel: "resumed",
    audit: resumedAudit,
    persistedBaselineEvents: persistedBefore,
  });

  const coldEvents = filterChainAuthoritativeEvents(
    coldAudit.authoritativeIndexedEvents ?? []
  );
  const resumedEvents = filterChainAuthoritativeEvents(
    resumedAudit.authoritativeIndexedEvents ?? []
  );
  const diff = diffCanonicalV2Reports(
    coldReport,
    resumedReport,
    coldEvents,
    resumedEvents
  );

  const result = {
    mode: "canonical_v2_cold_resume_gate",
    wallet: WALLET,
    gatePass: diff.gatePass,
    recommendation: diff.gatePass ? "PROCEED_TO_DB_MIGRATION" : "FIX_REQUIRED",
    cold: coldReport,
    resumed: resumedReport,
    diff,
    countRelationship: {
      freshCanonicalV2Count: coldReport.finalAuthoritativeCanonicalCount,
      freshCanonicalV2Hash: coldReport.canonicalIdentityHash,
      priorPreCanonicalFullRunCount: 379_204,
      priorSnapshotLegacyCount: 195_304,
      priorSnapshotCanonicalCount: 193_817,
      explanation: {
        vs379204:
          "379,204 used legacy dedupe_key merge (sparse DB ∪ full delta without canonical collapse). Canonical-v2 collapses identical physical chain logs before authoritative union.",
        vs195304:
          "195,304 is the legacy dedupe_key count from an older repaired snapshot/DB baseline, not a full fresh cold reconstruction.",
        vs193817:
          "193,817 collapsed legacy timestamp-bearing duplicates within that snapshot set; fresh full run is authoritative for canonical-v2 count.",
      },
    },
    authoritativeEventStats: {
      cold: coldAudit.authoritativeEventStats,
      resumed: resumedAudit.authoritativeEventStats,
    },
  };

  await writeFile(OUTPUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!diff.gatePass) {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error("[policy-a-canonical-v2-cold-resume] failed:", error);
  process.exit(1);
});
