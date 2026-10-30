#!/usr/bin/env tsx
/**
 * Class-D / unresolved_chain_order / gamma_resolution_incomplete audit for wallet 1.
 */
import "../tests/preload-env";
import { and, eq, sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletPositionLifecycles,
} from "@/lib/crossmarket/store/schema";
import { classifyChainEventIdentity } from "@/lib/walletLedger/canonicalChainIdentity";
import {
  filterChainAuthoritativeEvents,
  filterPersistableAuthoritativeEvents,
  summarizePersistableAuthoritativeEvents,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { loadPersistedWalletEventsPaginated } from "@/lib/walletLedger/indexed/store/persistedEventLoader";
import { assessUnresolvedChainOrder } from "@/lib/walletLedger/indexed/store/unresolvedChainOrder";
import { computeResolutionCoverage } from "@/lib/walletLedger/validity";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

const WALLET = "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";

async function main() {
  if (!isDatabaseEnabled()) process.exit(1);
  const db = getDb();

  const dbConn = getDb();
  const { events: loaded } = await loadPersistedWalletEventsPaginated(
    dbConn,
    WALLET.toLowerCase()
  );
  const events = loaded;
  const authoritative = filterChainAuthoritativeEvents(events);
  const summary = summarizePersistableAuthoritativeEvents(authoritative);
  const classD = authoritative.filter(
    (e) => classifyChainEventIdentity(e) === "unresolved_chain_log"
  );

  const unresolved = assessUnresolvedChainOrder(authoritative);

  const classDSamples = classD.slice(0, 5).map((e) => ({
    type: e.type,
    txHash: e.txHash,
    logIndex: e.logIndex,
    blockNumber: e.blockNumber,
    asset: e.asset?.slice(0, 24),
    cashUsd: e.cashUsd,
    shares: e.shares,
    dedupeKey: e.dedupeKey.slice(0, 80),
  }));

  const classDCash = classD.reduce((s, e) => s + Math.abs(e.cashUsd ?? 0), 0);
  const persistableCash = filterPersistableAuthoritativeEvents(authoritative).reduce(
    (s, e) => s + Math.abs(e.cashUsd ?? 0),
    0
  );

  const { positions } = await buildPositionLifecycles(WALLET, events);
  const gammaCov = computeResolutionCoverage(positions);
  const heldMissingGamma = positions.filter(
    (p) =>
      p.heldThroughResolution &&
      p.completed &&
      p.resolution &&
      !p.resolution.resolutionFinal
  );

  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, WALLET.toLowerCase()),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);

  const lifecycleRows = await db
    .select()
    .from(walletPositionLifecycles)
    .where(
      and(
        sql`lower(${walletPositionLifecycles.walletAddress}) = ${WALLET.toLowerCase()}`,
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    );

  const completedNet = lifecycleRows
    .filter((r) => r.completed && r.realizedPnl != null)
    .reduce((s, r) => s + (r.realizedPnl ?? 0), 0);

  console.log(
    JSON.stringify(
      {
        persistedEvents: events.length,
        authoritativeChain: summary.authoritativeTotal,
        persistable: summary.persistableTotal,
        classDExcluded: summary.unresolvedClassDTotal,
        classD_grossCashUsd: classDCash,
        persistable_grossCashUsd: persistableCash,
        classD_pctOfAuthoritativeCash:
          persistableCash + classDCash > 0
            ? classDCash / (persistableCash + classDCash)
            : null,
        classDSamples,
        unresolvedChainOrder: unresolved,
        gammaResolutionCoverage: gammaCov,
        heldCompletedMissingFinalGamma: heldMissingGamma.length,
        historyIncompleteReasons: metrics?.historyIncompleteReasons ?? [],
        historyComplete: metrics?.historyComplete ?? null,
        lifecycleCompleted: lifecycleRows.filter((r) => r.completed).length,
        ledgerNetFromLifecycles: completedNet,
      },
      null,
      2
    )
  );
}

void main();
