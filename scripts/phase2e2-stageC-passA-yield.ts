#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import "./preload-env";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletShadowBatchStatus,
} from "@/lib/crossmarket/store/schema";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

function firstSeenPassAWallets(limit = 10): string[] {
  const cohort: Array<{ wallet: string }> = JSON.parse(
    readFileSync(
      join(process.cwd(), "tmp/wallet-history/phase2e2-stageC-cohort.json"),
      "utf8"
    )
  ).wallets;
  const prefixMap = new Map(
    cohort.map((w) => [w.wallet.slice(0, 10).toLowerCase(), w.wallet.toLowerCase()])
  );
  const logs = readdirSync(join(process.cwd(), "tmp/wallet-history"))
    .filter((f) => f.startsWith("phase2e2-stageC-passA-") && f.endsWith(".log"))
    .sort();
  const seen = new Set<string>();
  const order: string[] = [];
  for (const log of logs) {
    const text = readFileSync(join(process.cwd(), "tmp/wallet-history", log), "utf8");
    for (const m of text.matchAll(/positions_fetch wallet=(0x[a-f0-9]{8})/gi)) {
      const wallet = prefixMap.get(m[1]!.toLowerCase());
      if (!wallet || seen.has(wallet)) continue;
      seen.add(wallet);
      order.push(wallet);
    }
  }
  return order.slice(-limit);
}

async function main(): Promise<void> {
  const wallets = firstSeenPassAWallets(10);
  const db = getDb();
  const rows = await Promise.all(
    wallets.map(async (wallet) => {
      const status = await db
        .select()
        .from(walletShadowBatchStatus)
        .where(
          and(
            eq(walletShadowBatchStatus.batchId, STAGE_C_BATCH_ID),
            eq(walletShadowBatchStatus.walletAddress, wallet)
          )
        )
        .limit(1);
      const metrics = await db
        .select()
        .from(walletHistoricalMetrics)
        .where(
          and(
            eq(walletHistoricalMetrics.walletAddress, wallet),
            eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
          )
        )
        .limit(1);
      const s = status[0];
      const m = metrics[0];
      const perf = s?.performance as { totalMs?: number } | null;
      const completedPositions = m?.completedPositions ?? 0;
      const eligible =
        s?.status === "complete" &&
        m?.credibilityMetricsValid === true &&
        completedPositions >= 10;
      return {
        wallet,
        status: s?.status ?? "missing",
        completedPositions,
        credibilityMetricsValid: m?.credibilityMetricsValid ?? false,
        eligibleFloor10: eligible,
        totalMs: perf?.totalMs ?? null,
        cohortReason: s?.cohortReason ?? null,
      };
    })
  );

  const complete = rows.filter((r) => r.status === "complete").length;
  const unusable = rows.filter((r) => r.status === "unusable").length;
  const deferred = rows.filter((r) => r.status === "deferred_infra").length;
  const eligible = rows.filter((r) => r.eligibleFloor10).length;
  const wallMs = rows.map((r) => r.totalMs).filter((v): v is number => v != null);
  const avgWallMs =
    wallMs.length > 0
      ? Math.round(wallMs.reduce((a, b) => a + b, 0) / wallMs.length)
      : null;

  console.log(
    JSON.stringify(
      {
        sample: rows,
        summary: {
          attempted: rows.length,
          complete,
          eligibleFloor10: eligible,
          unusable,
          deferred_infra: deferred,
          avgWallMs,
        },
        projection: {
          remainingNeverAttempted: 63,
          eligibleRate: rows.length > 0 ? eligible / rows.length : 0,
          expectedAdditionalEligible: Math.round((eligible / rows.length) * 63),
          projectedTotalEligible: 47 + Math.round((eligible / rows.length) * 63),
        },
        selectionBiasNote:
          "Pass A first-seen wallets are registry_unknown_hydration ranked by posted30d; not random from never_attempted pool.",
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
