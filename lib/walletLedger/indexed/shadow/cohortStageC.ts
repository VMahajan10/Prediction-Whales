import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/crossmarket/store/db";
import { whaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  STAGE_C_BATCH_ID,
  STAGE_C_COHORT_MANIFEST,
} from "@/lib/walletLedger/indexed/studyVersion";
import {
  buildFull50Cohort,
  productionFailureReason,
  productionGateLabel,
  summarizeCohortGateComposition,
  type EnrichedCohortWallet,
} from "@/lib/walletLedger/indexed/shadow/cohortV2";
import { writeCohortJson } from "@/lib/walletLedger/indexed/shadow/cohortV2";

export const STAGE_C_TARGET_COHORT = 220;
export const STAGE_C_ELIGIBILITY_TARGET = 100;

/** Production FAIL wallets that indexed as PASS in full50 (decision-semantics audit). */
export const KNOWN_DISAGREEMENT_WALLETS: Array<{
  wallet: string;
  label: string;
  cohortReason: string;
}> = [
  {
    wallet: "0xea6be1aefaaeda2d3c04dce5cea85e0bdc237fb1",
    label: "disagreement_fail_pass",
    cohortReason: "known_fail_to_pass_below_resolved_bets",
  },
  {
    wallet: "0xc20213ebbbc68bdecf3e712f8a1b3f7b3fb01623",
    label: "disagreement_fail_pass",
    cohortReason: "known_fail_to_pass_below_resolved_bets",
  },
  {
    wallet: "0x5f38747053bb642bb3ad456c5766ad9e6fb9eb70",
    label: "disagreement_fail_pass",
    cohortReason: "known_fail_to_pass_below_resolved_bets",
  },
  {
    wallet: "0xb6ed7b123bd7431139fefc6f24203934ee23cd23",
    label: "disagreement_fail_pass",
    cohortReason: "known_fail_to_pass_below_resolved_bets",
  },
  {
    wallet: "0x983f66208b937de8c190fa023ca2e29b731395e2",
    label: "disagreement_fail_pass",
    cohortReason: "known_fail_to_pass_below_resolved_bets",
  },
  {
    wallet: "0x6129d21da529b6d8d324131a9cf2b37b0b840807",
    label: "disagreement_fail_pass",
    cohortReason: "known_fail_to_pass_below_resolved_bets",
  },
  {
    wallet: "0xada100874d00e3331d00f2007a9c336a65009718",
    label: "disagreement_unusable",
    cohortReason: "known_fail_unusable_history",
  },
];

export type RegistryHistoryStratum =
  | "low_resolved"
  | "medium_resolved"
  | "capped_50"
  | "zero_resolved"
  | "unknown_hydration";

type RegistryRow = typeof whaleRegistry.$inferSelect;

export function registryHistoryStratum(row: RegistryRow): RegistryHistoryStratum {
  if (row.hydrationStatus !== "complete") return "unknown_hydration";
  if (row.resolvedBetsCount === 50) return "capped_50";
  if (row.resolvedBetsCount >= 10) return "medium_resolved";
  if (row.resolvedBetsCount > 0) return "low_resolved";
  return "zero_resolved";
}

function enrichedFromRegistry(
  row: RegistryRow | undefined,
  input: {
    label: string;
    wallet: string;
    transactionHash?: string;
    cohortReason: string;
    stratum: string;
    inclusionReason: string;
  }
): EnrichedCohortWallet {
  const gate = row ? productionGateLabel(row) : "unknown";
  return {
    label: input.label,
    wallet: input.wallet.toLowerCase(),
    transactionHash: input.transactionHash,
    cohortReason: input.cohortReason,
    stratum: input.stratum,
    productionGate: gate,
    productionFailureReason:
      gate === "pass" ? "ok" : productionFailureReason(row),
    inclusionReason: input.inclusionReason,
  };
}

function addWallet(
  cohort: Map<string, EnrichedCohortWallet>,
  wallet: EnrichedCohortWallet
): boolean {
  const key = wallet.wallet.toLowerCase();
  if (cohort.has(key)) return false;
  cohort.set(key, wallet);
  return true;
}

export function stageCCohortManifestPath(): string {
  return join(process.cwd(), "tmp", "wallet-history", STAGE_C_COHORT_MANIFEST);
}

export interface StageCCohortManifest {
  studyVersion: string;
  batchId: string;
  generatedAt: string;
  targetCohortSize: number;
  eligibilityTarget: number;
  selectionNotes: string[];
  composition: ReturnType<typeof summarizeCohortGateComposition> & {
    historyStratumBreakdown: Record<string, number>;
  };
  wallets: EnrichedCohortWallet[];
}

export function loadStageCCohortFromManifest(): StageCCohortManifest | null {
  const path = stageCCohortManifestPath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as StageCCohortManifest;
}

export function writeStageCCohortManifest(
  manifest: StageCCohortManifest
): { primaryPath: string; shadowComparePath: string } {
  const outDir = join(process.cwd(), "tmp", "wallet-history");
  mkdirSync(outDir, { recursive: true });
  const primaryPath = stageCCohortManifestPath();
  writeFileSync(primaryPath, JSON.stringify(manifest, null, 2));
  const shadowComparePath = writeCohortJson(manifest.batchId, manifest.wallets);
  return { primaryPath, shadowComparePath };
}

function historyStratumBreakdown(
  cohort: EnrichedCohortWallet[],
  byWallet: Map<string, RegistryRow>
): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const wallet of cohort) {
    const row = byWallet.get(wallet.wallet.toLowerCase());
    const stratum = row ? registryHistoryStratum(row) : "unknown_hydration";
    breakdown[stratum] = (breakdown[stratum] ?? 0) + 1;
  }
  return breakdown;
}

export async function buildStageCCohort(input?: {
  targetSize?: number;
  forceRebuild?: boolean;
}): Promise<StageCCohortManifest> {
  if (!input?.forceRebuild) {
    const existing = loadStageCCohortFromManifest();
    if (existing?.wallets.length) return existing;
  }

  const targetSize = input?.targetSize ?? STAGE_C_TARGET_COHORT;
  const db = getDb();
  const rows = await db.select().from(whaleRegistry);
  const byWallet = new Map(rows.map((r) => [r.walletAddress.toLowerCase(), r]));
  const cohort = new Map<string, EnrichedCohortWallet>();
  const selectionNotes: string[] = [];

  const full50 = await buildFull50Cohort();
  for (const wallet of full50) {
    addWallet(cohort, { ...wallet, inclusionReason: "full50_anchor" });
  }
  selectionNotes.push(`Seeded ${full50.length} full50 anchor wallets`);

  for (const spec of KNOWN_DISAGREEMENT_WALLETS) {
    const wallet = spec.wallet.toLowerCase();
    addWallet(
      cohort,
      enrichedFromRegistry(byWallet.get(wallet), {
        ...spec,
        wallet,
        stratum: "disagreement_class",
        inclusionReason: "known_disagreement_class",
      })
    );
  }
  selectionNotes.push(
    `Seeded ${KNOWN_DISAGREEMENT_WALLETS.length} known disagreement wallets`
  );

  const completeGe10 = rows
    .filter(
      (r) => r.hydrationStatus === "complete" && r.resolvedBetsCount >= 10
    )
    .sort((a, b) => b.resolvedBetsCount - a.resolvedBetsCount);
  let addedGe10 = 0;
  for (const row of completeGe10) {
    if (cohort.size >= targetSize) break;
    const wallet = row.walletAddress.toLowerCase();
    if (addWallet(
      cohort,
      enrichedFromRegistry(row, {
        label: `complete_ge10_${wallet.slice(2, 8)}`,
        wallet,
        cohortReason: `registry_complete_ge10:${registryHistoryStratum(row)}`,
        stratum: registryHistoryStratum(row),
        inclusionReason: "registry_complete_ge10",
      })
    )) {
      addedGe10 += 1;
    }
  }
  selectionNotes.push(`Added ${addedGe10} complete hydration wallets with resolved>=10`);

  const capped50Pass = rows
    .filter(
      (r) =>
        r.hydrationStatus === "complete" &&
        r.resolvedBetsCount === 50 &&
        productionGateLabel(r) === "pass"
    )
    .sort((a, b) => b.avgEv - a.avgEv);
  let addedCapped = 0;
  for (const row of capped50Pass) {
    if (cohort.size >= targetSize) break;
    const wallet = row.walletAddress.toLowerCase();
    if (addWallet(
      cohort,
      enrichedFromRegistry(row, {
        label: `capped50_pass_${wallet.slice(2, 8)}`,
        wallet,
        cohortReason: "registry_capped_50_pass",
        stratum: "capped_50",
        inclusionReason: "registry_capped_50_pass",
      })
    )) {
      addedCapped += 1;
    }
  }
  selectionNotes.push(`Added ${addedCapped} capped_50 production PASS wallets`);

  const lowFail = rows
    .filter(
      (r) =>
        r.hydrationStatus === "complete" &&
        r.resolvedBetsCount > 0 &&
        r.resolvedBetsCount < 10
    )
    .sort((a, b) => b.resolvedBetsCount - a.resolvedBetsCount);
  let addedLow = 0;
  for (const row of lowFail) {
    if (cohort.size >= targetSize) break;
    const wallet = row.walletAddress.toLowerCase();
    if (addWallet(
      cohort,
      enrichedFromRegistry(row, {
        label: `low_resolved_${wallet.slice(2, 8)}`,
        wallet,
        cohortReason: "registry_low_resolved_fail",
        stratum: "low_resolved",
        inclusionReason: "registry_low_resolved",
      })
    )) {
      addedLow += 1;
    }
  }
  selectionNotes.push(`Added ${addedLow} low resolved-count wallets`);

  const gateTargets = {
    pass: Math.round(targetSize * 0.45),
    fail: Math.round(targetSize * 0.35),
    unknown: Math.round(targetSize * 0.2),
  };

  function gateCount(gate: "pass" | "fail" | "unknown"): number {
    return [...cohort.values()].filter((w) => w.productionGate === gate).length;
  }

  const unknownCandidates = rows
    .filter((r) => r.hydrationStatus !== "complete")
    .sort((a, b) => b.postedCount30d - a.postedCount30d);
  let addedUnknown = 0;
  for (const row of unknownCandidates) {
    if (cohort.size >= targetSize) break;
    if (gateCount("unknown") >= gateTargets.unknown + 20) break;
    const wallet = row.walletAddress.toLowerCase();
    if (addWallet(
      cohort,
      enrichedFromRegistry(row, {
        label: `unknown_hydration_${wallet.slice(2, 8)}`,
        wallet,
        cohortReason: `registry_unknown_hydration:posted30d=${row.postedCount30d}`,
        stratum: "unknown_hydration",
        inclusionReason: "registry_unknown_hydration_activity",
      })
    )) {
      addedUnknown += 1;
    }
  }
  selectionNotes.push(
    `Added ${addedUnknown} unknown-hydration wallets (posted_count_30d ranked)`
  );

  const failCandidates = rows
    .filter(
      (r) =>
        r.hydrationStatus === "complete" && productionGateLabel(r) === "fail"
    )
    .sort((a, b) => b.resolvedBetsCount - a.resolvedBetsCount);
  for (const row of failCandidates) {
    if (cohort.size >= targetSize) break;
    if (gateCount("fail") >= gateTargets.fail) break;
    const wallet = row.walletAddress.toLowerCase();
    addWallet(
      cohort,
      enrichedFromRegistry(row, {
        label: `prod_fail_${wallet.slice(2, 8)}`,
        wallet,
        cohortReason: `registry_production_fail:${productionFailureReason(row)}`,
        stratum: registryHistoryStratum(row),
        inclusionReason: "registry_production_fail_fill",
      })
    );
  }

  const passCandidates = rows
    .filter(
      (r) =>
        r.hydrationStatus === "complete" && productionGateLabel(r) === "pass"
    )
    .sort((a, b) => b.resolvedBetsCount - a.resolvedBetsCount);
  for (const row of passCandidates) {
    if (cohort.size >= targetSize) break;
    const wallet = row.walletAddress.toLowerCase();
    addWallet(
      cohort,
      enrichedFromRegistry(row, {
        label: `prod_pass_fill_${wallet.slice(2, 8)}`,
        wallet,
        cohortReason: "registry_production_pass_fill",
        stratum: registryHistoryStratum(row),
        inclusionReason: "registry_production_pass_fill",
      })
    );
  }

  for (const row of unknownCandidates) {
    if (cohort.size >= targetSize) break;
    const wallet = row.walletAddress.toLowerCase();
    addWallet(
      cohort,
      enrichedFromRegistry(row, {
        label: `unknown_overflow_${wallet.slice(2, 8)}`,
        wallet,
        cohortReason: `registry_unknown_overflow:posted30d=${row.postedCount30d}`,
        stratum: "unknown_hydration",
        inclusionReason: "registry_unknown_hydration_overflow",
      })
    );
  }

  for (const row of rows.sort(
    (a, b) => b.postedCount30d - a.postedCount30d || b.resolvedBetsCount - a.resolvedBetsCount
  )) {
    if (cohort.size >= targetSize) break;
    const wallet = row.walletAddress.toLowerCase();
    addWallet(
      cohort,
      enrichedFromRegistry(row, {
        label: `registry_fill_${wallet.slice(2, 8)}`,
        wallet,
        cohortReason: "registry_general_fill",
        stratum: registryHistoryStratum(row),
        inclusionReason: "registry_general_fill",
      })
    );
  }

  const wallets = [...cohort.values()].slice(0, targetSize);
  const composition = summarizeCohortGateComposition(wallets);
  const manifest: StageCCohortManifest = {
    studyVersion: STAGE_C_BATCH_ID,
    batchId: STAGE_C_BATCH_ID,
    generatedAt: new Date().toISOString(),
    targetCohortSize: targetSize,
    eligibilityTarget: STAGE_C_ELIGIBILITY_TARGET,
    selectionNotes,
    composition: {
      ...composition,
      historyStratumBreakdown: historyStratumBreakdown(wallets, byWallet),
    },
    wallets,
  };
  writeStageCCohortManifest(manifest);
  return manifest;
}

export function printStageCCohortPreview(manifest: StageCCohortManifest): void {
  console.error(`\n=== Stage C cohort (${manifest.studyVersion}) ===`);
  console.error(`selected=${manifest.composition.selected}`);
  console.error(
    `production PASS=${manifest.composition.pass} FAIL=${manifest.composition.fail} UNKNOWN=${manifest.composition.unknown}`
  );
  console.error(
    `history strata: ${JSON.stringify(manifest.composition.historyStratumBreakdown)}`
  );
  for (const note of manifest.selectionNotes) {
    console.error(`  note: ${note}`);
  }
}
