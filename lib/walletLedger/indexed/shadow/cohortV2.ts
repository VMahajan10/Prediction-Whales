import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/crossmarket/store/db";
import { whaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  SMOKE_COHORT_10,
  type ShadowCohortWallet,
} from "@/lib/walletLedger/indexed/shadow/cohort";

import { walletMeetsCredibilityCriteria } from "@/lib/x-agent/walletCredibility";
import {
  MIN_WALLET_AVG_EV_DECIMAL,
  MIN_WALLET_RESOLVED_BETS,
} from "@/lib/x-agent/gateMetrics";

export const FULL50_TARGET = 50;
export const FULL50_MIN_COHORT = 40;
export const FULL50_PASS_TARGET = 20;
export const FULL50_FAIL_TARGET = 20;
export const FULL50_UNKNOWN_TARGET = 10;

export type ValidationCohortWallet = ShadowCohortWallet & {
  productionGate?: "pass" | "fail" | "unknown";
};

export type EnrichedCohortWallet = ShadowCohortWallet & {
  productionGate: "pass" | "fail" | "unknown";
  productionFailureReason: string;
  inclusionReason: string;
};

type RegistryRow = typeof whaleRegistry.$inferSelect;

const REQUIRED_VALIDATION_WALLETS: Array<{
  wallet: string;
  label: string;
  cohortReason: string;
  transactionHash?: string;
}> = [
  {
    wallet: "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66",
    label: "buy_sell_active",
    cohortReason: "required_buy_sell",
  },
  {
    wallet: "0x7e5972bfc25819775ee5a9d4f191919375487b8b",
    label: "high_avg_ev_truncated",
    cohortReason: "required_api_truncation",
  },
  {
    wallet: "0xdc41c39b95453c943174f369926018f6963bdd7e",
    label: "legacy50_high_ev",
    cohortReason: "required_high_volume",
  },
  {
    wallet: "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",
    label: "identity_mismatch_probe",
    cohortReason: "required_identity_probe",
    transactionHash:
      "0x59c3aad53bf226ee382efb4b33bbaa4b43563d4298450011e06c9837e891232a",
  },
];

export function productionGateLabel(row: RegistryRow | undefined): "pass" | "fail" | "unknown" {
  if (!row) return "unknown";
  if (row.hydrationStatus !== "complete") return "unknown";
  return walletMeetsCredibilityCriteria({
    resolvedBetsCount: row.resolvedBetsCount,
    avgEv: row.avgEv,
    winRate: row.winRate,
    closedCount: row.resolvedBetsCount,
  })
    ? "pass"
    : "fail";
}

export function productionFailureReason(row: RegistryRow | undefined): string {
  if (!row) return "not_in_registry";
  if (row.hydrationStatus !== "complete") {
    return `hydration_${row.hydrationStatus}`;
  }
  if (row.resolvedBetsCount < MIN_WALLET_RESOLVED_BETS) {
    return "below_resolved_bets";
  }
  if (row.avgEv < MIN_WALLET_AVG_EV_DECIMAL) {
    return "below_avg_ev";
  }
  if (row.avgStakeNotional <= 0) return "suspicious_avg_stake";
  return "below_credibility_threshold";
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
  const gate = productionGateLabel(row);
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

async function loadRegistryRows(): Promise<{
  rows: RegistryRow[];
  byWallet: Map<string, RegistryRow>;
}> {
  const db = getDb();
  const rows = await db.select().from(whaleRegistry);
  return {
    rows,
    byWallet: new Map(rows.map((r) => [r.walletAddress.toLowerCase(), r])),
  };
}

function gateCounts(cohort: Iterable<EnrichedCohortWallet | ValidationCohortWallet>): {
  pass: number;
  fail: number;
  unknown: number;
} {
  let pass = 0;
  let fail = 0;
  let unknown = 0;
  for (const wallet of cohort) {
    if (wallet.productionGate === "pass") pass += 1;
    else if (wallet.productionGate === "fail") fail += 1;
    else unknown += 1;
  }
  return { pass, fail, unknown };
}

function addEnriched(
  cohort: Map<string, EnrichedCohortWallet>,
  wallet: EnrichedCohortWallet
): void {
  cohort.set(wallet.wallet.toLowerCase(), wallet);
}

function countGate(
  cohort: Map<string, EnrichedCohortWallet>,
  gate: "pass" | "fail" | "unknown"
): number {
  return [...cohort.values()].filter((w) => w.productionGate === gate).length;
}

function seedRequiredAndSmoke(
  cohort: Map<string, EnrichedCohortWallet>,
  byWallet: Map<string, RegistryRow>
): void {
  for (const spec of REQUIRED_VALIDATION_WALLETS) {
    const wallet = spec.wallet.toLowerCase();
    addEnriched(
      cohort,
      enrichedFromRegistry(byWallet.get(wallet), {
        ...spec,
        wallet,
        stratum: "required",
        inclusionReason: "required_validation_anchor",
      })
    );
  }
  for (const spec of SMOKE_COHORT_10) {
    const wallet = spec.wallet.toLowerCase();
    if (cohort.has(wallet)) continue;
    addEnriched(
      cohort,
      enrichedFromRegistry(byWallet.get(wallet), {
        label: spec.label,
        wallet,
        transactionHash: spec.transactionHash,
        cohortReason: spec.cohortReason,
        stratum: spec.stratum,
        inclusionReason: "smoke10_anchor",
      })
    );
  }
}

function pickRoundRobin<T extends RegistryRow>(
  buckets: Map<string, T[]>,
  limit: number,
  onPick: (item: T, bucketKey: string) => boolean
): number {
  let added = 0;
  const keys = [...buckets.keys()].sort();
  while (added < limit) {
    let progressed = false;
    for (const key of keys) {
      if (added >= limit) break;
      const list = buckets.get(key) ?? [];
      while (list.length > 0) {
        const item = list.shift()!;
        if (onPick(item, key)) {
          added += 1;
          progressed = true;
        }
        break;
      }
    }
    if (!progressed) break;
  }
  return added;
}

export async function buildValidationCohort20(): Promise<ValidationCohortWallet[]> {
  const full = await buildFull50Cohort({ targetSize: 20, passTarget: 10, failTarget: 10, unknownTarget: 0 });
  return full.map(({ productionGate, ...rest }) => ({
    ...rest,
    productionGate,
  }));
}

export async function buildFull50Cohort(input?: {
  targetSize?: number;
  passTarget?: number;
  failTarget?: number;
  unknownTarget?: number;
}): Promise<EnrichedCohortWallet[]> {
  const targetSize = input?.targetSize ?? FULL50_TARGET;
  const passTarget = input?.passTarget ?? FULL50_PASS_TARGET;
  const failTarget = input?.failTarget ?? FULL50_FAIL_TARGET;
  const unknownTarget = input?.unknownTarget ?? FULL50_UNKNOWN_TARGET;

  const { rows, byWallet } = await loadRegistryRows();
  const cohort = new Map<string, EnrichedCohortWallet>();
  seedRequiredAndSmoke(cohort, byWallet);

  const passCandidates = rows
    .filter((r) => productionGateLabel(r) === "pass")
    .sort((a, b) => b.resolvedBetsCount - a.resolvedBetsCount);
  const failCandidates = rows
    .filter((r) => productionGateLabel(r) === "fail")
    .sort((a, b) => b.resolvedBetsCount - a.resolvedBetsCount);
  const unknownCandidates = rows
    .filter((r) => productionGateLabel(r) === "unknown")
    .sort((a, b) => {
      const ah = a.hydrationStatus ?? "";
      const bh = b.hydrationStatus ?? "";
      return ah.localeCompare(bh) || b.resolvedBetsCount - a.resolvedBetsCount;
    });

  const failByReason = new Map<string, RegistryRow[]>();
  for (const row of failCandidates) {
    const reason = productionFailureReason(row);
    const list = failByReason.get(reason) ?? [];
    list.push(row);
    failByReason.set(reason, list);
  }

  const unknownByReason = new Map<string, RegistryRow[]>();
  for (const row of unknownCandidates) {
    const reason = productionFailureReason(row);
    const list = unknownByReason.get(reason) ?? [];
    list.push(row);
    unknownByReason.set(reason, list);
  }

  const seenWallet = new Set(cohort.keys());

  function addRegistryRow(
    row: RegistryRow,
    label: string,
    stratum: string,
    inclusionReason: string
  ): boolean {
    const wallet = row.walletAddress.toLowerCase();
    if (seenWallet.has(wallet)) return false;
    seenWallet.add(wallet);
    addEnriched(
      cohort,
      enrichedFromRegistry(row, {
        label,
        wallet,
        cohortReason: `${stratum}:${productionFailureReason(row)}`,
        stratum,
        inclusionReason,
      })
    );
    return true;
  }

  for (const row of passCandidates) {
    if (countGate(cohort, "pass") >= passTarget) break;
    addRegistryRow(
      row,
      `prod_pass_${row.walletAddress.slice(2, 8)}`,
      "production_pass",
      "registry_production_pass"
    );
  }

  pickRoundRobin(
    failByReason,
    failTarget - countGate(cohort, "fail"),
    (row, reason) => {
      if (countGate(cohort, "fail") >= failTarget) return false;
      return addRegistryRow(
        row,
        `prod_fail_${reason}_${row.walletAddress.slice(2, 8)}`,
        `production_fail_${reason}`,
        `registry_production_fail:${reason}`
      );
    }
  );

  for (const row of failCandidates) {
    if (countGate(cohort, "fail") >= failTarget) break;
    addRegistryRow(
      row,
      `prod_fail_extra_${row.walletAddress.slice(2, 8)}`,
      "production_fail",
      "registry_production_fail_fill"
    );
  }

  pickRoundRobin(
    unknownByReason,
    unknownTarget - countGate(cohort, "unknown"),
    (row, reason) => {
      if (countGate(cohort, "unknown") >= unknownTarget) return false;
      return addRegistryRow(
        row,
        `prod_unknown_${reason}_${row.walletAddress.slice(2, 8)}`,
        `production_unknown_${reason}`,
        `registry_production_unknown:${reason}`
      );
    }
  );

  for (const row of unknownCandidates) {
    if (countGate(cohort, "unknown") >= unknownTarget) break;
    addRegistryRow(
      row,
      `prod_unknown_extra_${row.walletAddress.slice(2, 8)}`,
      "production_unknown",
      "registry_production_unknown_fill"
    );
  }

  for (const row of passCandidates) {
    if (cohort.size >= targetSize) break;
    addRegistryRow(
      row,
      `prod_pass_extra_${row.walletAddress.slice(2, 8)}`,
      "production_pass",
      "registry_production_pass_fill"
    );
  }
  for (const row of failCandidates) {
    if (cohort.size >= targetSize) break;
    addRegistryRow(
      row,
      `prod_fail_overflow_${row.walletAddress.slice(2, 8)}`,
      "production_fail",
      "registry_production_fail_overflow"
    );
  }
  for (const row of unknownCandidates) {
    if (cohort.size >= targetSize) break;
    addRegistryRow(
      row,
      `prod_unknown_overflow_${row.walletAddress.slice(2, 8)}`,
      "production_unknown",
      "registry_production_unknown_overflow"
    );
  }

  return [...cohort.values()].slice(0, targetSize);
}

export function summarizeCohortGateComposition(
  cohort: EnrichedCohortWallet[]
): {
  selected: number;
  pass: number;
  fail: number;
  unknown: number;
  failReasonBreakdown: Record<string, number>;
} {
  const counts = gateCounts(cohort);
  const failReasonBreakdown: Record<string, number> = {};
  for (const wallet of cohort) {
    if (wallet.productionGate !== "fail") continue;
    failReasonBreakdown[wallet.productionFailureReason] =
      (failReasonBreakdown[wallet.productionFailureReason] ?? 0) + 1;
  }
  return {
    selected: cohort.length,
    ...counts,
    failReasonBreakdown,
  };
}

export function printFull50CohortPreview(
  cohort: EnrichedCohortWallet[],
  stage: string
): void {
  const composition = summarizeCohortGateComposition(cohort);
  console.error(`\n=== ${stage} cohort ===`);
  console.error(`selected=${composition.selected}`);
  console.error(
    `production PASS=${composition.pass} FAIL=${composition.fail} UNKNOWN=${composition.unknown}`
  );
  if (Object.keys(composition.failReasonBreakdown).length > 0) {
    console.error(
      `production FAIL reasons: ${JSON.stringify(composition.failReasonBreakdown)}`
    );
  }
  for (const wallet of cohort) {
    console.error(
      `  ${wallet.wallet} gate=${wallet.productionGate} prodReason=${wallet.productionFailureReason} — ${wallet.inclusionReason} (${wallet.label})`
    );
  }
}

export function writeCohortJson(
  batchId: string,
  cohort: EnrichedCohortWallet[]
): string {
  const outDir = join(process.cwd(), "tmp", "wallet-history", "shadow-compare");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `cohort-${batchId}.json`);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        batchId,
        composition: summarizeCohortGateComposition(cohort),
        wallets: cohort.map((w) => ({
          wallet: w.wallet,
          label: w.label,
          productionGate: w.productionGate,
          productionFailureReason: w.productionFailureReason,
          inclusionReason: w.inclusionReason,
          cohortReason: w.cohortReason,
          stratum: w.stratum,
          transactionHash: w.transactionHash,
        })),
      },
      null,
      2
    )
  );
  return jsonPath;
}
