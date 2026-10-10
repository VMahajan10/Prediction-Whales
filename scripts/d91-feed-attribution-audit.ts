#!/usr/bin/env tsx
/**
 * Read-only production wallet-attribution audit for 0xd91e… feed rows.
 * No DB writes, no resolver/feed changes.
 */
import "../tests/preload-env";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { feedTrades } from "@/lib/crossmarket/store/schema";
import { resolveWalletByTradeHash } from "@/lib/polymarket";
import { probeWalletHistoryCounts } from "@/lib/walletLedger/fetchers";
import { decodeLog, orderFilledInvolvesWallet } from "@/lib/walletLedger/onchain/decode";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";

const D91 = "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296";

const ORDER_FILLED_TOPIC_PREFIX = "0xd543adfd";
const SYSTEM_ADDRESSES = new Set([
  "0xe2222d279d744050d28e00520010520000310f59",
  "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
  "0xe111180000d2663c0091e4f400237545b87b996b",
  "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
  "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
  "0x2791bca1f2de4661ed88a30c99d7a81a19cb3c11",
  "0xd95518d7300450c286f6985bc271e52ebe6f0000",
  "0x0000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000001010",
]);

type TxLog = {
  address: string;
  topics: string[];
  data: string;
  logIndex?: string;
  blockNumber?: string;
};

function topicToAddress(topic: string): string | null {
  if (!topic || topic.length !== 66) return null;
  return (`0x${topic.slice(26)}`).toLowerCase();
}

function isUserAddress(addr: string): boolean {
  return !SYSTEM_ADDRESSES.has(addr) && addr !== "0x0000000000000000000000000000000000000000";
}

interface CandidateVote {
  address: string;
  logIndex: number;
  contract: string;
  topic0: string;
  topicIndex: number;
  phase: "primary" | "asset_fallback";
}

function collectWalletCandidatesWithProvenance(
  logs: TxLog[],
  assetHex: string | null
): { counts: Map<string, number>; votes: CandidateVote[] } {
  const counts = new Map<string, number>();
  const votes: CandidateVote[] = [];

  const considerLog = (log: TxLog, requireAsset: boolean, phase: CandidateVote["phase"]) => {
    const data = log.data?.slice(2) ?? "";
    const refsAsset = assetHex ? data.includes(assetHex) : true;
    if (requireAsset && assetHex && !refsAsset) return;

    const isOrderFilled = log.topics[0]?.startsWith(ORDER_FILLED_TOPIC_PREFIX);
    if (!requireAsset && !isOrderFilled && !refsAsset) return;

    const logIndex = log.logIndex
      ? Number.parseInt(log.logIndex, 16)
      : votes.length;

    for (let i = 1; i < log.topics.length; i++) {
      const addr = topicToAddress(log.topics[i]);
      if (!addr || !isUserAddress(addr)) continue;
      counts.set(addr, (counts.get(addr) ?? 0) + 1);
      votes.push({
        address: addr,
        logIndex,
        contract: log.address.toLowerCase(),
        topic0: log.topics[0]?.toLowerCase() ?? "",
        topicIndex: i,
        phase,
      });
    }
  };

  for (const log of logs) {
    considerLog(log, !!assetHex, "primary");
  }
  if (counts.size === 0 && assetHex) {
    for (const log of logs) {
      considerLog(log, true, "asset_fallback");
    }
  }

  return { counts, votes };
}

function pickBestWallet(counts: Map<string, number>): {
  winner: string | null;
  winnerVotes: number;
  tied: string[];
} {
  let winner: string | null = null;
  let winnerVotes = 0;
  const tied: string[] = [];
  for (const [addr, count] of counts.entries()) {
    if (count > winnerVotes) {
      winner = addr;
      winnerVotes = count;
      tied.length = 0;
      tied.push(addr);
    } else if (count === winnerVotes && count > 0) {
      tied.push(addr);
    }
  }
  return { winner, winnerVotes, tied };
}

type D91Participation =
  | "order_filled_maker"
  | "order_filled_taker"
  | "erc1155_operator"
  | "erc1155_from"
  | "erc1155_to"
  | "ctf_stakeholder_split_merge"
  | "topic_only_candidate"
  | "not_in_decoded_receipt"
  | "present_non_economic_topic_only"
  | "other";

function classifyD91Participation(input: {
  decodedEvents: ReturnType<typeof summarizeDecodedLogs>;
  d91Votes: CandidateVote[];
  winner: string | null;
  d91InReceipt: boolean;
}): D91Participation {
  const w = D91;
  if (input.decodedEvents.orderFilled.some((f) => f.maker === w)) {
    return "order_filled_maker";
  }
  if (input.decodedEvents.orderFilled.some((f) => f.taker === w)) {
    return "order_filled_taker";
  }
  if (input.decodedEvents.erc1155.some((t) => t.operator === w)) {
    return "erc1155_operator";
  }
  if (input.decodedEvents.erc1155.some((t) => t.from === w)) {
    return "erc1155_from";
  }
  if (input.decodedEvents.erc1155.some((t) => t.to === w)) {
    return "erc1155_to";
  }
  if (
    input.decodedEvents.splitsMerges.some((s) => s.stakeholder === w)
  ) {
    return "ctf_stakeholder_split_merge";
  }
  if (input.d91Votes.length > 0 && input.winner === w) {
    return "topic_only_candidate";
  }
  if (input.d91Votes.length > 0) {
    return "present_non_economic_topic_only";
  }
  if (!input.d91InReceipt) {
    return "not_in_decoded_receipt";
  }
  return "other";
}

function summarizeDecodedLogs(logs: TxLog[]) {
  const orderFilled: Array<{
    logIndex: number;
    contract: string;
    maker: string;
    taker: string;
    makerAssetId: string;
    takerAssetId: string;
    involvesD91: boolean;
  }> = [];
  const erc1155: Array<{
    logIndex: number;
    operator: string;
    from: string;
    to: string;
    tokenId: string;
  }> = [];
  const splitsMerges: Array<{
    logIndex: number;
    kind: string;
    stakeholder: string;
    conditionId: string;
  }> = [];
  const other: Array<{ logIndex: number; type: string; contract: string }> = [];

  for (const log of logs) {
    const logIndex = log.logIndex ? Number.parseInt(log.logIndex, 16) : -1;
    const parsed = decodeLog({
      ...log,
      blockNumber: log.blockNumber ?? "0x0",
      transactionHash: "",
      logIndex: log.logIndex ?? "0x0",
    });
    if (parsed.type === "order_filled") {
      orderFilled.push({
        logIndex,
        contract: parsed.event.contractAddress,
        maker: parsed.event.maker,
        taker: parsed.event.taker,
        makerAssetId: parsed.event.makerAssetId,
        takerAssetId: parsed.event.takerAssetId,
        involvesD91: orderFilledInvolvesWallet(parsed.event, D91),
      });
    } else if (parsed.type === "erc1155_transfer") {
      erc1155.push({
        logIndex,
        operator: parsed.event.operator,
        from: parsed.event.from,
        to: parsed.event.to,
        tokenId: parsed.event.tokenId,
      });
    } else if (parsed.type === "position_split") {
      splitsMerges.push({
        logIndex,
        kind: "split",
        stakeholder: parsed.event.stakeholder,
        conditionId: parsed.event.conditionId,
      });
    } else if (parsed.type === "positions_merge") {
      splitsMerges.push({
        logIndex,
        kind: "merge",
        stakeholder: parsed.event.stakeholder,
        conditionId: parsed.event.conditionId,
      });
    } else if (parsed.type !== "unparsed") {
      other.push({
        logIndex,
        type: parsed.type,
        contract: log.address.toLowerCase(),
      });
    }
  }
  return { orderFilled, erc1155, splitsMerges, other };
}

function payloadField(payload: unknown, key: string): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  return (payload as Record<string, unknown>)[key];
}

async function resolveWalletAuditFromLogs(
  hash: string,
  logs: TxLog[],
  assetId?: string
): Promise<{
  wallet: string | null;
  source: "onchain" | "data-api-asset" | "data-api-global" | null;
}> {
  const assetHex = assetId
    ? BigInt(assetId).toString(16).padStart(64, "0")
    : null;
  const { counts } = collectWalletCandidatesWithProvenance(logs, assetHex);
  const onchain = pickBestWallet(counts).winner;
  if (onchain) return { wallet: onchain, source: "onchain" };
  const fromApi = await resolveWalletByTradeHash(hash, assetId);
  if (fromApi) {
    return {
      wallet: fromApi,
      source: assetId ? "data-api-asset" : "data-api-global",
    };
  }
  return { wallet: null, source: null };
}

async function main(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(feedTrades)
    .where(sql`lower(${feedTrades.proxyWallet}) = ${D91}`)
    .orderBy(feedTrades.tradedAt);

  const rpc = new PolygonRpcClient();
  const participationCounts = new Map<D91Participation, number>();
  const makerFreq = new Map<string, number>();
  const takerFreq = new Map<string, number>();
  const voteRuleCounts = new Map<string, number>();

  let onchainResolver = 0;
  let apiResolver = 0;
  let d91Winner = 0;
  let d91MakerOrTaker = 0;
  let d91TopicOnlyWinner = 0;
  let clearEconomicOther = 0;
  let ambiguous = 0;
  let receiptMissing = 0;

  const payloadProxyMatch = { matchesD91: 0, differs: 0, missing: 0 };
  const perTx: unknown[] = [];

  let idx = 0;
  for (const row of rows) {
    idx += 1;
    if (idx % 10 === 0) {
      console.error(`[d91-audit] progress ${idx}/${rows.length}`);
    }
    const payload = row.payload;
    const assetId =
      (payloadField(payload, "assetId") as string | undefined)?.trim() ||
      undefined;
    const conditionId =
      (payloadField(payload, "conditionId") as string | undefined) ?? null;
    const payloadProxy = (
      payloadField(payload, "proxyWallet") as string | undefined
    )?.toLowerCase();
    if (!payloadProxy) payloadProxyMatch.missing += 1;
    else if (payloadProxy === D91) payloadProxyMatch.matchesD91 += 1;
    else payloadProxyMatch.differs += 1;

    const hash =
      row.transactionHash?.toLowerCase() ??
      (row.tradeId.startsWith("0x") ? row.tradeId.toLowerCase() : null);

    if (!hash) {
      receiptMissing += 1;
      continue;
    }

    const receipt = await rpc.getTransactionReceipt(hash);
    const logs = (receipt?.logs ?? []) as TxLog[];
    if (logs.length === 0) {
      receiptMissing += 1;
      continue;
    }

    const assetHex = assetId
      ? BigInt(assetId).toString(16).padStart(64, "0")
      : null;
    const { counts, votes } = collectWalletCandidatesWithProvenance(
      logs,
      assetHex
    );
    const pick = pickBestWallet(counts);
    const resolved = await resolveWalletAuditFromLogs(hash, logs, assetId);
    if (resolved.source === "onchain") onchainResolver += 1;
    else if (resolved.source) apiResolver += 1;

    const decoded = summarizeDecodedLogs(logs);
    for (const f of decoded.orderFilled) {
      makerFreq.set(f.maker, (makerFreq.get(f.maker) ?? 0) + 1);
      takerFreq.set(f.taker, (takerFreq.get(f.taker) ?? 0) + 1);
    }

    const d91Votes = votes.filter((v) => v.address === D91);
    for (const v of d91Votes) {
      const key = `${v.contract}|${v.topic0}|topic${v.topicIndex}|${v.phase}`;
      voteRuleCounts.set(key, (voteRuleCounts.get(key) ?? 0) + 1);
    }

    const d91InReceipt = votes.some((v) => v.address === D91) ||
      decoded.orderFilled.some((f) => f.involvesD91) ||
      decoded.erc1155.some(
        (t) => t.from === D91 || t.to === D91 || t.operator === D91
      );

    const participation = classifyD91Participation({
      decodedEvents: decoded,
      d91Votes,
      winner: pick.winner,
      d91InReceipt,
    });
    participationCounts.set(
      participation,
      (participationCounts.get(participation) ?? 0) + 1
    );

    if (pick.winner === D91) d91Winner += 1;
    if (
      participation === "order_filled_maker" ||
      participation === "order_filled_taker"
    ) {
      d91MakerOrTaker += 1;
    } else if (pick.winner === D91) {
      d91TopicOnlyWinner += 1;
    }

    const economicSubjects = new Set<string>();
    for (const f of decoded.orderFilled) {
      if (isUserAddress(f.maker)) economicSubjects.add(f.maker);
      if (isUserAddress(f.taker)) economicSubjects.add(f.taker);
    }
    const d91Economic =
      participation === "order_filled_maker" ||
      participation === "order_filled_taker";
    const hasNonD91Economic = [...economicSubjects].some((a) => a !== D91);
    if (decoded.orderFilled.length > 0 && hasNonD91Economic && !d91Economic) {
      clearEconomicOther += 1;
    }
    if (decoded.orderFilled.length === 0) {
      ambiguous += 1;
    }

    const d91VoteBreakdown = d91Votes.map((v) => ({
      ...v,
      why: `collectWalletCandidates: topics[${v.topicIndex}] address +1 (${v.phase})`,
    }));

    perTx.push({
      tradeId: row.tradeId,
      txHash: hash,
      conditionId,
      assetId,
      feedProxyWallet: row.proxyWallet,
      payloadProxyWallet: payloadProxy ?? null,
      decoded,
      resolver: {
        replicatedWinner: pick.winner,
        replicatedWinnerVotes: pick.winnerVotes,
        allCandidates: [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([address, votes]) => ({ address, votes })),
        d91Votes: d91VoteBreakdown,
        whyD91Won:
          pick.winner === D91
            ? `Highest topic-index vote count (${pick.winnerVotes}); d91e not OrderFilled maker/taker`
            : pick.winner
              ? `Another address had higher topic vote count`
              : "No candidates",
        resolveWalletForTradeEquivalent: resolved,
      },
      d91Participation: participation,
    });
  }

  const topMakers = [...makerFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  const topTakers = [...takerFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const probeTargets = new Set<string>();
  for (const [addr] of topMakers.slice(0, 8)) probeTargets.add(addr);
  for (const [addr] of topTakers.slice(0, 8)) probeTargets.add(addr);
  probeTargets.add(D91);

  const apiProbes: Record<string, Awaited<ReturnType<typeof probeWalletHistoryCounts>>> =
    {};
  for (const addr of probeTargets) {
    apiProbes[addr] = await probeWalletHistoryCounts(addr);
  }

  const total = rows.length;
  const summary = {
    mode: "d91_feed_attribution_audit",
    wallet: D91,
    totalFeedRows: total,
    participationCounts: Object.fromEntries(participationCounts),
    resolverStats: {
      onchainResolver,
      apiResolver,
      d91Winner,
      d91MakerOrTaker,
      d91TopicOnlyWinner,
      d91ConfirmedEconomicPct: total ? (d91MakerOrTaker / total) * 100 : 0,
      d91TopicOnlyUnsupportedPct: total ? (d91TopicOnlyWinner / total) * 100 : 0,
      clearEconomicOtherWalletPct: total ? (clearEconomicOther / total) * 100 : 0,
      ambiguousPct: total ? (ambiguous / total) * 100 : 0,
      receiptMissing,
    },
    d91VoteRules: [...voteRuleCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([rule, count]) => ({ rule, count })),
    topMakers,
    topTakers,
    payloadProxyMatch,
    feedIngestionPaths: {
      liveSocket:
        "lib/x-agent/runShadowDaemon.ts socketTradeToWhale → resolveWalletForTrade(tx, assetId) → whale.proxyWallet → recordFeedTradeHistory",
      apiFeedBackfill:
        "app/api/feed/route.ts fetchWhaleBackfill → normalizeTrade raw.proxyWallet → recordFeedTradeHistory (parallel enrich uses existing proxyWallet)",
      persistedColumn:
        "lib/feed/feedTradeHistoryCore.ts buildFeedTradeRow copies proxyWallet from input",
    },
    apiProbes,
    verdict: "" as string,
  };

  if (d91TopicOnlyWinner > total * 0.5 && d91MakerOrTaker === 0) {
    summary.verdict = "RESOLVER_MISATTRIBUTION_CONFIRMED";
  } else if (d91MakerOrTaker > total * 0.8) {
    summary.verdict = "ATTRIBUTION_CORRECT_PROXY_ROLE";
  } else {
    summary.verdict = "ATTRIBUTION_AMBIGUOUS_MORE_EVIDENCE";
  }

  const outDir = join(process.cwd(), "tmp");
  writeFileSync(
    join(outDir, "d91-feed-attribution-summary.json"),
    JSON.stringify(summary, null, 2)
  );
  writeFileSync(
    join(outDir, "d91-feed-attribution-per-tx.json"),
    JSON.stringify(perTx, null, 2)
  );
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
