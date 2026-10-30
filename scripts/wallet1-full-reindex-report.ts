#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql, eq, and } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletPositionLifecycles,
} from "@/lib/crossmarket/store/schema";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import {
  persistAuthoritativePhase,
  persistDerivedPhase,
  countWalletLedgerEvents,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { fetchPolymarketProfilePnl } from "@/lib/walletLedger/reconciliation/fetchProfilePnl";

const WALLET = "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";

async function main() {
  if (!isDatabaseEnabled()) process.exit(1);
  const before = await countWalletLedgerEvents(WALLET);

  const audit = await runIndexedWalletAudit({
    label: "wallet1-full-reindex",
    wallet: WALLET,
    providerId: "etherscan_v2",
    fullHistory: true,
    allowEarlierThanIncremental: true,
    resumeCheckpoint: true,
  });

  const phase1 = await persistAuthoritativePhase(audit);
  const phase2 = await persistDerivedPhase(audit);

  const after = await countWalletLedgerEvents(WALLET);
  const db = getDb();
  const lifecycles = await db
    .select()
    .from(walletPositionLifecycles)
    .where(
      and(
        sql`lower(${walletPositionLifecycles.walletAddress}) = ${WALLET}`,
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    );
  const completed = lifecycles.filter((r) => r.completed);
  const gp = completed
    .filter((r) => (r.realizedPnl ?? 0) > 0)
    .reduce((s, r) => s + (r.realizedPnl ?? 0), 0);
  const gl = completed
    .filter((r) => (r.realizedPnl ?? 0) < 0)
    .reduce((s, r) => s + Math.abs(r.realizedPnl ?? 0), 0);
  const net = gp - gl;

  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, WALLET),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);

  const profile = await fetchPolymarketProfilePnl(WALLET);

  console.log(
    JSON.stringify(
      {
        eventsBefore: before,
        eventsAfter: after,
        eventsUpserted: phase1.eventsUpserted,
        authoritativeInAudit: audit.authoritativeIndexedEvents?.length ?? 0,
        classD: phase1.authoritativePersistDiagnostics.unresolvedClassDCount,
        lifecycles: lifecycles.length,
        lifecyclesCompleted: completed.length,
        ledgerGrossProfit: gp,
        ledgerGrossLoss: gl,
        ledgerNetPnl: net,
        profileTotalPnl: profile.pnl,
        profileSource: profile.source,
        historyComplete: metrics?.historyComplete ?? null,
        historyIncompleteReasons: metrics?.historyIncompleteReasons ?? [],
        indexedCredibility: audit.indexedCredibility,
      },
      null,
      2
    )
  );
}

void main();
