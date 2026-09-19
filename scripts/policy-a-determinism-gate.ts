#!/usr/bin/env tsx
/**
 * Policy A determinism gate for the four pilot wallets.
 * Read-only: no hydration, no persistence, no new Policy A metrics.
 */
import "../tests/preload-env";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { buildAuthoritativeCoverageFingerprint } from "@/lib/walletLedger/indexed/store/authoritativeCoverageFingerprint";
import {
  buildAuthoritativeReconstructionReport,
  diffAuthoritativeReconstructionReports,
} from "@/lib/walletLedger/indexed/store/authoritativeReconstructionReport";
import {
  filterChainAuthoritativeEvents,
  hashAuthoritativeEventIdentities,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { buildLogIndexTaxonomyReport } from "@/lib/walletLedger/indexed/store/logIndexTaxonomy";
import {
  countWalletLedgerEvents,
  loadPersistedWalletEvents,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import {
  compareReplayToSnapshot,
  loadValidationSnapshot,
  replayMetricsFromValidationSnapshot,
  verifyLifecycleEpisodeDeterminism,
} from "@/lib/walletLedger/indexed/store/validationSnapshot";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import { mergeApiAndChainEvents } from "@/lib/walletLedger/onchain/normalize";

const PILOT_WALLETS = [
  {
    wallet: "0x4f29e103339919c4baaea2a60195cf1c8bb27a7e",
    role: "source_specific",
    runColdResume: true,
  },
  {
    wallet: "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6",
    role: "adaptive_earlier",
    runColdResume: false,
  },
  {
    wallet: "0x1ff3d3fdef2558f3eb4aabdd7011a0245df8eb39",
    role: "regression_control",
    runColdResume: false,
  },
  {
    wallet: "0xde7be6d489bce070a959e0cb813128ae659b5f4b",
    role: "truncation_case",
    runColdResume: false,
  },
] as const;

const ONLY_WALLET = process.env.ONLY_WALLET?.toLowerCase();
const SKIP_COLD_RESUME = process.env.SKIP_COLD_RESUME === "1";
const SNAPSHOT_ROOT = path.join(
  process.cwd(),
  ".cache",
  "wallet-validation-snapshots"
);

async function findLatestSnapshot(wallet: string): Promise<string | null> {
  const files = await readdir(SNAPSHOT_ROOT).catch(() => []);
  const matches = files
    .filter((file) => file.startsWith(`${wallet.toLowerCase()}-`))
    .sort();
  if (matches.length === 0) return null;
  return path.join(SNAPSHOT_ROOT, matches.at(-1)!);
}

async function gateWallet(pilot: (typeof PILOT_WALLETS)[number]) {
  const wallet = pilot.wallet.toLowerCase();
  const snapshotFile = await findLatestSnapshot(wallet);
  if (!snapshotFile) {
    return {
      wallet,
      role: pilot.role,
      gatePass: false,
      reason: "missing_validation_snapshot",
    };
  }

  const snapshot = await loadValidationSnapshot(snapshotFile);
  let replay: Awaited<ReturnType<typeof replayMetricsFromValidationSnapshot>>;
  try {
    replay = await replayMetricsFromValidationSnapshot(snapshot, {
      frozen: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      wallet,
      role: pilot.role,
      gatePass: false,
      reason: message.startsWith("INPUT_MISMATCH")
        ? "INPUT_MISMATCH"
        : "replay_failed",
      inputMismatchReason: message,
      snapshotPath: snapshotFile,
    };
  }
  const comparison = compareReplayToSnapshot(snapshot, replay);
  const combined = mergeApiAndChainEvents(
    snapshot.apiEvents,
    snapshot.authoritativeEvents
  );
  const lifecycleDeterminism = await verifyLifecycleEpisodeDeterminism(
    wallet,
    combined,
    snapshot.gammaCacheEntries
  );
  const logIndexTaxonomy = buildLogIndexTaxonomyReport({
    authoritativeEvents: snapshot.authoritativeEvents,
  });

  let coldResume:
    | Awaited<ReturnType<typeof runColdResumeDiff>>
    | { skipped: true; reason: string }
    | null = null;
  if (pilot.runColdResume && !SKIP_COLD_RESUME) {
    coldResume = await runColdResumeDiff(wallet);
  } else if (pilot.runColdResume) {
    coldResume = { skipped: true, reason: "SKIP_COLD_RESUME=1" };
  }

  const gatePass =
    !replay.inputMismatch &&
    comparison.exactMatch &&
    lifecycleDeterminism.deterministic &&
    replay.metrics.completedPositions === snapshot.auditMetrics.completedPositions;

  return {
    wallet,
    role: pilot.role,
    snapshotPath: snapshotFile,
    authoritativeIdentityHash: snapshot.authoritativeEventIdentityHash,
    metricComputationInputHash:
      snapshot.metricComputationInputHash ?? snapshot.replayInputHash,
    auditLifecycleInputHash: snapshot.auditLifecycleInputHash,
    replayLifecycleInputHash: replay.replayLifecycleInputHash,
    inputMismatch: replay.inputMismatch,
    inputMismatchReason: replay.inputMismatchReason,
    snapshotMetrics: snapshot.auditMetrics,
    replay,
    comparison,
    lifecycleDeterminism,
    logIndexTaxonomy,
    coldResume,
    gatePass,
  };
}

async function runColdResumeDiff(wallet: string) {
  const persistedBefore = await countWalletLedgerEvents(wallet);
  const coldAudit = await runIndexedWalletAudit({
    label: "determinism-gate-cold",
    wallet,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: false,
    allowEarlierThanIncremental: true,
  });
  const resumedAudit = await runIndexedWalletAudit({
    label: "determinism-gate-resumed",
    wallet,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: true,
    allowEarlierThanIncremental: true,
  });

  const coldEvents = filterChainAuthoritativeEvents(
    coldAudit.authoritativeIndexedEvents ?? []
  );
  const resumedEvents = filterChainAuthoritativeEvents(
    resumedAudit.authoritativeIndexedEvents ?? []
  );
  const coldReport = buildAuthoritativeReconstructionReport({
    runLabel: "cold",
    audit: coldAudit,
    persistedBaselineEvents: persistedBefore,
  });
  const resumedReport = buildAuthoritativeReconstructionReport({
    runLabel: "resumed",
    audit: resumedAudit,
    persistedBaselineEvents: persistedBefore,
  });
  const diff = diffAuthoritativeReconstructionReports(
    coldReport,
    resumedReport,
    coldEvents,
    resumedEvents
  );

  const queryPlan = coldAudit.debugReport?.queryPlan;
  const perContractFromBlock: Record<string, number> = {};
  for (const query of queryPlan?.queries ?? []) {
    perContractFromBlock[query.contract] = query.fromBlock;
  }
  const fingerprint = buildAuthoritativeCoverageFingerprint({
    wallet,
    provider: coldAudit.providerId,
    perContractFromBlock,
    throughBlock: coldAudit.throughBlock ?? 0,
    querySubjects: coldAudit.debugReport?.scanSubjects ?? [wallet],
    authoritativeEvents: coldEvents,
  });

  return {
    coldReport,
    resumedReport,
    diff,
    coldIdentityHash: hashAuthoritativeEventIdentities(coldEvents),
    resumedIdentityHash: hashAuthoritativeEventIdentities(resumedEvents),
    identityHashMatch:
      hashAuthoritativeEventIdentities(coldEvents) ===
      hashAuthoritativeEventIdentities(resumedEvents),
    coverageFingerprint: fingerprint,
    diagnosis: {
      likely378kVs195kCause:
        diff.onlyInCold.length > diff.onlyInResumed.length
          ? "cold reconstruction includes identities absent from resumed/checkpoint path — checkpoint gaps or sparse DB merge inflation"
          : diff.onlyInResumed.length > diff.onlyInCold.length
            ? "resumed path double-counted or cold under-fetched relative to DB-augmented merge"
            : diff.onlyInCold.length === 0 && diff.onlyInResumed.length === 0
              ? "cold and resumed authoritative identity sets match"
              : "bidirectional identity drift — inspect per-range samples",
    },
  };
}

async function main() {
  const targets = ONLY_WALLET
    ? PILOT_WALLETS.filter((pilot) => pilot.wallet === ONLY_WALLET)
    : PILOT_WALLETS;
  if (targets.length === 0) {
    throw new Error(`Wallet not in pilot set: ${ONLY_WALLET}`);
  }

  const results = [];
  for (const pilot of targets) {
    console.error(`[determinism-gate] evaluating ${pilot.wallet}`);
    results.push(await gateWallet(pilot));
  }

  const allPass = results.every((result) => result.gatePass);
  const coldResume = results.find((result) => result.coldResume && !("skipped" in result.coldResume));

  console.log(
    JSON.stringify(
      {
        mode: "policy_a_determinism_gate",
        walletsProcessed: results.length,
        recommendation: allPass
          ? "READY_FOR_BOUNDED_COHORT_HYDRATION"
          : "FIX_REQUIRED",
        report: {
          A_378k_vs_195k:
            coldResume && !("skipped" in coldResume.coldResume!)
              ? {
                  coldAuthoritative:
                    coldResume.coldResume.coldReport.authoritativeMergedEvents,
                  resumedAuthoritative:
                    coldResume.coldResume.resumedReport.authoritativeMergedEvents,
                  identityHashMatch: coldResume.coldResume.identityHashMatch,
                  onlyInColdCount:
                    coldResume.coldResume.diff.onlyInCold.length,
                  onlyInResumedCount:
                    coldResume.coldResume.diff.onlyInResumed.length,
                  diagnosis: coldResume.coldResume.diagnosis,
                  diffSample: {
                    onlyInCold: coldResume.coldResume.diff.onlyInCold.slice(
                      0,
                      20
                    ),
                    onlyInResumed:
                      coldResume.coldResume.diff.onlyInResumed.slice(0, 20),
                  },
                }
              : "run with ONLY_WALLET=0x4f29... and SKIP_COLD_RESUME unset",
          B_authoritativeReconstructionFix:
            "logIndex coordinate backfill after authoritative merge; durable coverage fingerprint gates baseline completeness",
          C_logIndexTaxonomy: results.map((result) => ({
            wallet: result.wallet,
            taxonomy: result.logIndexTaxonomy,
          })),
          D_lifecycleDeterminism: results.map((result) => ({
            wallet: result.wallet,
            ...result.lifecycleDeterminism,
          })),
          E_frozenSnapshotDrift: results.map((result) => ({
            wallet: result.wallet,
            exactReplay: result.comparison,
            metricComputationInputHash: result.metricComputationInputHash,
          })),
          F_replayTable: results.map((result) => ({
            wallet: result.wallet,
            authoritativeIdentityHash: result.authoritativeIdentityHash,
            snapshotMetrics: result.snapshotMetrics,
            replayMetrics: result.replay.metrics,
            comparison: result.comparison,
            lifecycleDeterminism: result.lifecycleDeterminism,
            gatePass: result.gatePass,
          })),
        },
        results,
      },
      null,
      2
    )
  );

  if (!allPass) {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error("[policy-a-determinism-gate] failed:", error);
  process.exit(1);
});
