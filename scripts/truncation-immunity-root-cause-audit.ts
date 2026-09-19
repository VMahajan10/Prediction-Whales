#!/usr/bin/env tsx
/**
 * Read-only truncation-immunity root-cause audit.
 * Fetches API activity for diagnosis only — does NOT persist hydration.
 */
import "../tests/preload-env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletLedgerEvents,
} from "@/lib/crossmarket/store/schema";
import { computeIndexedBoundaryStats } from "@/lib/walletLedger/indexed/authoritativeEvents";
import { buildEtherscanQueryPlan } from "@/lib/walletLedger/indexed/queryPlan";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { buildWalletLogQueries } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import {
  fetchActivityHistory,
  fetchPositionsSnapshot,
  fetchTradeHistory,
} from "@/lib/walletLedger/fetchers";
import { resolvePolymarketHistoryIdentity } from "@/lib/walletLedger/identity";
import {
  CONDITIONAL_TOKENS_ADDRESS,
  CTF_EXCHANGE_LEGACY_ADDRESS,
  CTF_EXCHANGE_V1_ADDRESS,
  CTF_EXCHANGE_V2_ADDRESS,
  EXCHANGE_ADDRESSES,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  POLYMARKET_EXCHANGE_INITIAL_BLOCK,
} from "@/lib/walletLedger/onchain/contracts";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import type { ActivityApiRow } from "@/lib/walletLedger/types";

const PILOT = "0xd27cc742d023d06ef633a4c880cf1ff1836ec081".toLowerCase();
const COMPARE_WALLETS = [
  "0x01e6e3c5cfe50943e7721398054cb1e22032e7e0",
  "0x0afa7be11ff4e36567d8ada047853122e399eff3",
  "0x1fb7053bb490c6ec05a78fe2ed383af48526fb66",
  "0x4f29e103339919c4baaea2a60195cf1c8bb27a7e",
  "0x162f6fff88a52864f2ecc9833e58089d5254798d",
].map((w) => w.toLowerCase());

function iso(ts: number | null | undefined): string | null {
  if (ts == null || !Number.isFinite(Number(ts)) || Number(ts) <= 0) return null;
  return new Date(Number(ts) * 1000).toISOString();
}

function ledgerRelevantActivity(row: ActivityApiRow): {
  relevant: boolean;
  reason: string;
} {
  const type = (row.type ?? "").toUpperCase();
  if (type === "TRADE") {
    const side = (row.side ?? "").toUpperCase();
    if (side === "BUY" || side === "SELL") {
      return { relevant: true, reason: "trade_buy_sell" };
    }
    return { relevant: false, reason: "trade_missing_side" };
  }
  if (["REDEEM", "MERGE", "SPLIT"].includes(type)) {
    return { relevant: true, reason: `lifecycle_${type.toLowerCase()}` };
  }
  return { relevant: false, reason: `ignored_activity_type:${type || "unknown"}` };
}

async function inspectApiActivity(wallet: string) {
  const [activity, trades] = await Promise.all([
    fetchActivityHistory(wallet, { interPageDelayMs: 25 }),
    fetchTradeHistory(wallet, { interPageDelayMs: 25 }),
  ]);
  const sorted = [...activity.rows].sort(
    (a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0)
  );
  const oldest20 = sorted.slice(0, 20).map((row) => {
    const rel = ledgerRelevantActivity(row);
    return {
      timestamp: Number(row.timestamp ?? 0),
      timestampIso: iso(Number(row.timestamp ?? 0)),
      type: row.type ?? null,
      side: row.side ?? null,
      conditionId: row.conditionId?.slice(0, 18) ?? null,
      asset: row.asset?.slice(0, 18) ?? null,
      txHash: row.transactionHash ?? null,
      proxyWallet: row.proxyWallet?.toLowerCase() ?? null,
      usdcSize: row.usdcSize ?? null,
      size: row.size ?? null,
      ledgerRelevant: rel.relevant,
      ledgerRelevanceReason: rel.reason,
    };
  });

  const preMay2024 = sorted.filter(
    (r) => Number(r.timestamp ?? 0) < 1_715_000_000
  );
  const preMay2024Relevant = preMay2024.filter(
    (r) => ledgerRelevantActivity(r).relevant
  );

  const apiOldestTs = sorted.length
    ? Number(sorted[0]?.timestamp ?? 0)
    : null;
  const relevantOldest = sorted.find((r) => ledgerRelevantActivity(r).relevant);

  return {
    activityRows: activity.rows.length,
    activityTruncated: activity.truncated,
    tradeRows: trades.rows.length,
    tradesTruncated: trades.truncated,
    apiOldestTimestamp: apiOldestTs,
    apiOldestTimestampIso: iso(apiOldestTs),
    oldestLedgerRelevant: relevantOldest
      ? {
          timestamp: Number(relevantOldest.timestamp ?? 0),
          timestampIso: iso(Number(relevantOldest.timestamp ?? 0)),
          type: relevantOldest.type,
          side: relevantOldest.side,
          txHash: relevantOldest.transactionHash,
          ledgerRelevanceReason: ledgerRelevantActivity(relevantOldest).reason,
        }
      : null,
    oldest20,
    preMay2024: {
      total: preMay2024.length,
      ledgerRelevant: preMay2024Relevant.length,
      activityTypes: [...new Set(preMay2024.map((r) => r.type ?? "null"))],
      sampleTxHashes: preMay2024Relevant
        .map((r) => r.transactionHash)
        .filter(Boolean)
        .slice(0, 10),
    },
  };
}

async function inspectIdentity(wallet: string) {
  const [identity, positions] = await Promise.all([
    resolvePolymarketHistoryIdentity({ wallet }),
    fetchPositionsSnapshot(wallet),
  ]);
  const proxyWallets = [
    ...new Set(
      positions
        .map((p) => p.proxyWallet?.toLowerCase())
        .filter((w): w is string => Boolean(w))
    ),
  ];
  return {
    requestedWallet: identity.requestedWallet,
    historyWallet: identity.historyWallet,
    resolutionMethod: identity.resolutionMethod,
    confidence: identity.confidence,
    positionsOnlyMismatch: identity.positionsOnlyMismatch,
    alternateCandidates: identity.alternateCandidates,
    candidateWallets: identity.candidateWallets.map((c) => ({
      wallet: c.wallet,
      activityCount: c.activityCount,
      tradeCount: c.tradeCount,
      positionsCount: c.positionsCount,
      historyScore: c.historyScore,
      source: c.source,
    })),
    positionsProxyWallets: proxyWallets,
    positionsCount: positions.length,
    evidenceNotes: identity.evidence.notes,
  };
}

async function inspectPersistedEvents(wallet: string) {
  const db = getDb();
  const [stats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      nullTs: sql<number>`count(*) filter (where ${walletLedgerEvents.blockTimestamp} is null)::int`,
      minBlock: sql<number | null>`min(${walletLedgerEvents.blockNumber})`,
      maxBlock: sql<number | null>`max(${walletLedgerEvents.blockNumber})`,
      minTs: sql<number | null>`min(${walletLedgerEvents.blockTimestamp}) filter (where ${walletLedgerEvents.blockTimestamp} is not null and ${walletLedgerEvents.blockTimestamp} > 0)`,
      maxTs: sql<number | null>`max(${walletLedgerEvents.blockTimestamp}) filter (where ${walletLedgerEvents.blockTimestamp} is not null and ${walletLedgerEvents.blockTimestamp} > 0)`,
    })
    .from(walletLedgerEvents)
    .where(eq(walletLedgerEvents.walletAddress, wallet));

  const bySource = await db
    .select({
      source: walletLedgerEvents.source,
      count: sql<number>`count(*)::int`,
      minBlock: sql<number | null>`min(${walletLedgerEvents.blockNumber})`,
      minTs: sql<number | null>`min(${walletLedgerEvents.blockTimestamp}) filter (where ${walletLedgerEvents.blockTimestamp} is not null and ${walletLedgerEvents.blockTimestamp} > 0)`,
    })
    .from(walletLedgerEvents)
    .where(eq(walletLedgerEvents.walletAddress, wallet))
    .groupBy(walletLedgerEvents.source);

  const byType = await db
    .select({
      eventType: walletLedgerEvents.eventType,
      count: sql<number>`count(*)::int`,
      minBlock: sql<number | null>`min(${walletLedgerEvents.blockNumber})`,
    })
    .from(walletLedgerEvents)
    .where(eq(walletLedgerEvents.walletAddress, wallet))
    .groupBy(walletLedgerEvents.eventType);

  return { stats, bySource, byType };
}

function contractRole(address: string): string {
  const map: Record<string, string> = {
    [CTF_EXCHANGE_LEGACY_ADDRESS]: "CTF Exchange legacy",
    [CTF_EXCHANGE_V1_ADDRESS]: "CTF Exchange v1",
    [NEG_RISK_CTF_EXCHANGE_ADDRESS]: "Neg Risk CTF Exchange",
    [CTF_EXCHANGE_V2_ADDRESS]: "CTF Exchange v2",
    [CONDITIONAL_TOKENS_ADDRESS]: "ConditionalTokens",
  };
  return map[address.toLowerCase()] ?? address;
}

async function inspectQueryPlan(wallet: string, fromBlock: number, toBlock: number) {
  const plan = buildEtherscanQueryPlan(wallet, fromBlock, toBlock);
  const queries = buildWalletLogQueries(wallet, fromBlock, toBlock);

  const contractReports = EXCHANGE_ADDRESSES.concat([CONDITIONAL_TOKENS_ADDRESS]).map(
    (contract) => {
      const contractQueries = queries.filter(
        (q) => q.address.toLowerCase() === contract.toLowerCase()
      );
      return {
        contract,
        role: contractRole(contract),
        configuredStartBlock: POLYMARKET_EXCHANGE_INITIAL_BLOCK,
        queryFromBlock: fromBlock,
        queryToBlock: toBlock,
        queryCount: contractQueries.length,
        walletRoles: contractQueries.map((q) =>
          q.topics?.[3] ? "taker" : q.topics?.[2] ? "maker" : "stakeholder"
        ),
        legacyIncluded: contract === CTF_EXCHANGE_LEGACY_ADDRESS,
      };
    }
  );

  return {
    exchangeInitialBlock: POLYMARKET_EXCHANGE_INITIAL_BLOCK,
    actualHydrationFromBlock: fromBlock,
    headBlock: toBlock,
    planSummary: {
      walletLogQueries: plan.walletLogQueries,
      contractsQueried: plan.contractsQueried,
      legacyExchangeInPlan: plan.contractsQueried.includes(
        CTF_EXCHANGE_LEGACY_ADDRESS
      ),
      multiplication: plan.multiplication,
      queries: plan.queries,
    },
    perContract: contractReports,
  };
}

async function classifyOldestTxs(
  wallet: string,
  txHashes: string[],
  queryFromBlock: number
) {
  const db = getDb();
  const rpc = new PolygonRpcClient();
  const results = [];

  for (const txHash of txHashes) {
    const [persisted] = await db
      .select({
        count: sql<number>`count(*)::int`,
        minBlock: sql<number | null>`min(${walletLedgerEvents.blockNumber})`,
        types: sql<string>`string_agg(distinct ${walletLedgerEvents.eventType}, ',')`,
      })
      .from(walletLedgerEvents)
      .where(
        sql`${walletLedgerEvents.walletAddress} = ${wallet} AND lower(${walletLedgerEvents.txHash}) = ${txHash.toLowerCase()}`
      );

    const receipt = await rpc.getTransactionReceipt(txHash);
    const block =
      receipt?.blockNumber != null ? Number(receipt.blockNumber) : null;
    const contracts = receipt
      ? [...new Set(receipt.logs.map((l) => l.address.toLowerCase()))]
      : [];
    const exchangeHits = contracts.filter((c) =>
      EXCHANGE_ADDRESSES.includes(c as (typeof EXCHANGE_ADDRESSES)[number])
    );
    const ctfHit = contracts.includes(CONDITIONAL_TOKENS_ADDRESS);

    results.push({
      txHash,
      receiptFound: receipt != null,
      blockNumber: block,
      beforeQueryFromBlock:
        block != null ? block < queryFromBlock : null,
      beforeExchangeInitialBlock:
        block != null ? block < POLYMARKET_EXCHANGE_INITIAL_BLOCK : null,
      persistedEventCount: persisted?.count ?? 0,
      persistedEventTypes: persisted?.types ?? null,
      logContracts: contracts,
      exchangeContracts: exchangeHits.map((c) => ({
        address: c,
        role: contractRole(c),
      })),
      conditionalTokensPresent: ctfHit,
      missReason:
        block != null && block < queryFromBlock
          ? block < POLYMARKET_EXCHANGE_INITIAL_BLOCK
            ? "block_before_POLYMARKET_EXCHANGE_INITIAL_BLOCK"
            : "block_before_actual_query_fromBlock"
          : persisted?.count
            ? null
            : receipt
              ? "tx_exists_on_chain_but_not_in_persisted_events"
              : "receipt_not_found",
    });
  }
  return results;
}

async function pilotEarlierScan(
  wallet: string,
  pilotFromBlock: number,
  toBlock: number,
  apiOldestTimestamp: number
) {
  const provider = new EtherscanV2LogProvider();
  const queries = buildWalletLogQueries(wallet, pilotFromBlock, toBlock);
  const allLogs = [];
  for (const query of queries) {
    const { logs } = await provider.getLogsPaginated(query, {
      interPageDelayMs: 50,
    });
    allLogs.push(...logs);
  }

  const persisted = await loadPersistedWalletEvents(wallet);
  const persistedBlocks = new Set(
    persisted.map((e) => e.blockNumber).filter((b): b is number => b != null)
  );

  const uniqueBlocks = [...new Set(allLogs.map((l) => Number(l.blockNumber)))].sort(
    (a, b) => a - b
  );
  const earliestBlock = uniqueBlocks[0] ?? null;
  const newBlocks = uniqueBlocks.filter((b) => !persistedBlocks.has(b));

  const rpc = new PolygonRpcClient();
  const blockTimestamps = new Map<number, number>();
  const sampleBlocks = uniqueBlocks.slice(0, 25);
  for (const block of sampleBlocks) {
    const timestamp = await rpc.getBlockTimestamp(block);
    if (timestamp) blockTimestamps.set(block, timestamp);
  }
  const earliestTimestamp =
    sampleBlocks.length > 0
      ? blockTimestamps.get(sampleBlocks[0]!) ?? null
      : null;

  const pilotOnlyEvents = allLogs
    .filter((log) => !persistedBlocks.has(Number(log.blockNumber)))
    .map((log) => ({
      blockNumber: Number(log.blockNumber),
      address: log.address.toLowerCase(),
      timestamp: blockTimestamps.get(Number(log.blockNumber)) ?? 0,
    }));

  const mergedTimestamps = [
    ...persisted.filter((e) => e.timestamp > 0).map((e) => e.timestamp),
    ...pilotOnlyEvents.map((e) => e.timestamp).filter((t) => t > 0),
  ];
  const mergedSynthetic = mergedTimestamps.map((timestamp, idx) => ({
    wallet,
    conditionId: "",
    asset: `pilot-${idx}`,
    timestamp,
    type: "BUY" as const,
    shares: 1,
    cashUsd: 1,
    dedupeKey: `pilot-${idx}`,
    source: "polygon" as const,
  }));
  const boundary = computeIndexedBoundaryStats(
    mergedSynthetic,
    apiOldestTimestamp
  );

  const perContractEarliest: Record<string, number | null> = {};
  for (const contract of EXCHANGE_ADDRESSES) {
    const blocks = allLogs
      .filter((l) => l.address.toLowerCase() === contract)
      .map((l) => Number(l.blockNumber));
    perContractEarliest[contract] =
      blocks.length > 0 ? Math.min(...blocks) : null;
  }

  return {
    pilotFromBlock,
    toBlock,
    additionalLogsFound: allLogs.length,
    additionalBlocksNotInPersisted: newBlocks.length,
    earliestBlock,
    earliestTimestamp,
    earliestTimestampIso: iso(earliestTimestamp),
    perContractEarliestBlock: Object.fromEntries(
      Object.entries(perContractEarliest).map(([addr, block]) => [
        contractRole(addr),
        block,
      ])
    ),
    eventsBeforeApiBoundaryIfMerged: boundary.eventsBeforeApiBoundary,
    extendsBeforeApiBoundaryIfMerged: boundary.extendsBeforeApiBoundary,
    indexedOldestIfMerged: boundary.indexedOldestTimestamp,
    persistedEventCount: persisted.length,
    note: "Read-only Etherscan log scan; no persistence; lifecycle metrics not recomputed",
  };
}

async function diagnoseWallet(wallet: string, opts?: { runPilot?: boolean }) {
  const db = getDb();
  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, wallet),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  const [coverage] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, wallet))
    .limit(1);

  const identity = await inspectIdentity(wallet);
  const historyWallet = identity.historyWallet ?? wallet;
  const api = await inspectApiActivity(historyWallet);
  const persisted = await inspectPersistedEvents(historyWallet);

  const fromBlock = coverage?.fromBlock ?? POLYMARKET_EXCHANGE_INITIAL_BLOCK;
  const toBlock = coverage?.lastIndexedBlock ?? POLYMARKET_EXCHANGE_INITIAL_BLOCK;
  const queryPlan = await inspectQueryPlan(historyWallet, fromBlock, toBlock);

  const txClassifications = await classifyOldestTxs(
    historyWallet,
    api.preMay2024.sampleTxHashes as string[],
    fromBlock
  );

  let pilot: Awaited<ReturnType<typeof pilotEarlierScan>> | null = null;
  if (opts?.runPilot) {
    const minTxBlock = txClassifications
      .map((t) => t.blockNumber)
      .filter((b): b is number => b != null)
      .sort((a, b) => a - b)[0];
    const pilotFrom =
      minTxBlock != null
        ? Math.max(0, minTxBlock - 10_000)
        : 48_000_000;
    const pilotTo =
      minTxBlock != null
        ? Math.min(toBlock, minTxBlock + 50_000)
        : POLYMARKET_EXCHANGE_INITIAL_BLOCK + 25_000;
    pilot = await pilotEarlierScan(
      historyWallet,
      pilotFrom,
      pilotTo,
      api.apiOldestTimestamp ?? 0
    );
  }

  const category = (() => {
    const irrelevantOnly =
      api.preMay2024.ledgerRelevant === 0 && api.preMay2024.total > 0;
    if (irrelevantOnly) return "A";
    const startBlockMiss = txClassifications.some(
      (t) => t.missReason === "block_before_POLYMARKET_EXCHANGE_INITIAL_BLOCK"
    );
    if (startBlockMiss) return "C";
    const legacyMiss = txClassifications.some(
      (t) =>
        t.receiptFound &&
        t.persistedEventCount === 0 &&
        t.exchangeContracts.some((c) => c.address === CTF_EXCHANGE_LEGACY_ADDRESS)
    );
    if (legacyMiss) return "B";
    const identityIssue =
      identity.positionsOnlyMismatch ||
      identity.resolutionMethod === "unresolved" ||
      identity.confidence === "low";
    if (identityIssue) return "D";
    if (api.preMay2024.ledgerRelevant > 0) return "E";
    return "E";
  })();

  return {
    wallet,
    historyWallet,
    category,
    persistedMetrics: metrics
      ? {
          completedPositions: metrics.completedPositions,
          historyValidity: metrics.historyValidity,
          reasons: metrics.historyIncompleteReasons,
        }
      : null,
    persistedCoverage: coverage,
    identity,
    api,
    persisted,
    queryPlan,
    txClassifications,
    pilot,
  };
}

async function compareCohort(wallets: string[]) {
  const summaries = [];
  for (const wallet of wallets) {
    const db = getDb();
    const [metrics] = await db
      .select()
      .from(walletHistoricalMetrics)
      .where(
        and(
          eq(walletHistoricalMetrics.walletAddress, wallet),
          eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
        )
      )
      .limit(1);
    const [coverage] = await db
      .select()
      .from(walletHistoryCoverage)
      .where(eq(walletHistoryCoverage.walletAddress, wallet))
      .limit(1);

    let apiOldest: number | null = null;
    let preMayRelevant = 0;
    try {
      const activity = await fetchActivityHistory(wallet, { interPageDelayMs: 15 });
      const sorted = [...activity.rows].sort(
        (a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0)
      );
      apiOldest = sorted.length ? Number(sorted[0]?.timestamp ?? 0) : null;
      preMayRelevant = sorted.filter(
        (r) =>
          Number(r.timestamp ?? 0) < 1_715_000_000 &&
          ledgerRelevantActivity(r).relevant
      ).length;
    } catch {
      // skip
    }

    summaries.push({
      wallet,
      reasons: metrics?.historyIncompleteReasons ?? [],
      apiOldestTimestampIso: iso(apiOldest),
      indexedOldestTimestampIso: iso(coverage?.indexedOldestTimestamp ?? null),
      eventsBeforeApiBoundary: coverage?.eventsBeforeApiBoundary ?? 0,
      fromBlock: coverage?.fromBlock ?? null,
      minPersistedBlock: null as number | null,
      preMay2024LedgerRelevant: preMayRelevant,
      likelyCategory:
        preMayRelevant > 0 && (coverage?.eventsBeforeApiBoundary ?? 0) === 0
          ? apiOldest != null && apiOldest < 1_715_000_000
            ? "C_or_B"
            : "E"
          : "A_or_truncation_symptom",
    });
  }
  return summaries;
}

async function main() {
  const pilot = await diagnoseWallet(PILOT, { runPilot: true });
  const cohort = await compareCohort(COMPARE_WALLETS);

  console.log(
    JSON.stringify(
      {
        mode: "truncation_immunity_root_cause_audit",
        pilot,
        cohortComparison: cohort,
        timestampCoveragePctSemantics: {
          currentMeaning:
            "Fraction of unique missing blocks successfully resolved during the hydration run block-timestamp cache pass (resolvedBlocks / uniqueMissingBlocks). NOT the share of wallet_ledger_events rows with non-null block_timestamp.",
          observedMismatch:
            "coverage.timestampCoveragePct can be 1.0 while most persisted wallet_ledger_events.block_timestamp remain NULL if timestamps were not written back to event rows after cache resolution.",
          proposedRename:
            "block_timestamp_cache_resolution_pct during hydration",
          proposedCompanionField:
            "persisted_event_timestamp_coverage_pct = count(block_timestamp not null) / count(*) from wallet_ledger_events",
        },
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
