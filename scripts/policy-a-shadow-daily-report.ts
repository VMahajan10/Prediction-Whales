#!/usr/bin/env tsx
/**
 * Policy A shadow product validation — daily snapshot (engineering frozen).
 *
 * Does NOT hydrate wallets, run Batch 4, or change Policy A thresholds.
 * Run once per day during the 14-day observation window.
 */
import "./preload-env";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  buildDailyShadowReport,
  buildShadowPeriodSummary,
  POLICY_A_SHADOW_ENGINEERING_FROZEN,
  POLICY_A_SHADOW_PERIOD_DAYS,
} from "@/lib/walletLedger/indexed/shadow/policyAShadowValidation";

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const dayKey = process.env.DAY_KEY ?? new Date().toISOString().slice(0, 10);
  const report = await buildDailyShadowReport({ dayKey });
  const summary = await buildShadowPeriodSummary();

  const output = {
    ...report,
    shadowSummary: {
      engineeringFrozen: POLICY_A_SHADOW_ENGINEERING_FROZEN,
      observationDays: POLICY_A_SHADOW_PERIOD_DAYS,
      trajectory: summary.trajectory,
      policyVersion: summary.policyVersion,
      metricVersion: summary.metricVersion,
    },
    operationalNotes: [
      "Engineering frozen — shadow candidate only; no Batch 4 / Tier-3 hydration.",
      "PRIORITY_REPAIR queue flags feed-visible or materially active UNKNOWN wallets only.",
      "unresolved_chain_order and insufficient_completed_positions UNKNOWN are valid terminal states.",
      "Production enforcement is NOT enabled automatically.",
    ],
  };

  const outDir = join(process.cwd(), "tmp/wallet-history");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `policy-a-shadow-daily-${dayKey}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(JSON.stringify(output, null, 2));
  console.error(`\n[wrote] ${outPath}`);
  console.error(`[recommendation] ${report.recommendation}`);
  if (report.priorityRepairQueue.length > 0) {
    console.error(
      `[priority-repair] ${report.priorityRepairQueue.length} wallet(s) — see .cache/policy-a-shadow/priority-repair-queue.json`
    );
  }
}

void main().catch((error) => {
  console.error("[policy-a-shadow-daily-report] failed:", error);
  process.exit(1);
});
