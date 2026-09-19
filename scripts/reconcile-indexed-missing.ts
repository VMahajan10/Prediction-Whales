#!/usr/bin/env tsx
/**
 * Phase 2D completeness reconciliation — missing API tx diagnosis.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.json scripts/reconcile-indexed-missing.ts
 *   npx tsx --tsconfig tsconfig.json scripts/reconcile-indexed-missing.ts --wallet 0x0562...
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import {
  fetchActivityHistory,
  fetchTradeHistory,
} from "@/lib/walletLedger/fetchers";
import {
  checkpointPath,
  readEtherscanCheckpoint,
  type EtherscanQueryCheckpoint,
} from "@/lib/walletLedger/indexed/checkpoint";
import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import {
  buildWalletLogQueries,
} from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import {
  CONDITIONAL_TOKENS_ADDRESS,
  CTF_EXCHANGE_V1_ADDRESS,
  CTF_EXCHANGE_V2_ADDRESS,
  EXCHANGE_ADDRESSES,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  ORDER_FILLED_TOPICS,
  POLYMARKET_EXCHANGE_INITIAL_BLOCK,
  TOPIC_ORDER_FILLED_NEG_RISK,
  TOPIC_ORDER_FILLED_V1,
  TOPIC_ORDERS_MATCHED_NEG_RISK,
  TOPIC_PAYOUT_REDEMPTION,
  TOPIC_POSITION_SPLIT,
  TOPIC_POSITIONS_MERGE,
  TOPIC_PROXY_WALLET_EXECUTION,
} from "@/lib/walletLedger/onchain/contracts";
import {
  decodeLog,
  decodeOrderFilledNegRisk,
  decodeOrderFilledV1,
  topicToAddress,
} from "@/lib/walletLedger/onchain/decode";
import { parsedEventsToLedgerEvents } from "@/lib/walletLedger/onchain/normalize";
import { PolygonRpcClient, dedupeLogs, walletTopic } from "@/lib/walletLedger/onchain/rpc";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";
import {
  deduplicateLedgerEvents,
  normalizeActivityRows,
  normalizeTradeRows,
} from "@/lib/walletLedger/normalize";
import type { ActivityApiRow, TradeApiRow } from "@/lib/walletLedger/types";

const DEFAULT_WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";
const SCAN_FROM = POLYMARKET_EXCHANGE_INITIAL_BLOCK;
const SCAN_TO = 92_831_448;

const EXCHANGE_LABELS: Record<string, string> = {
  [CTF_EXCHANGE_V1_ADDRESS]: "CTF Exchange v1",
  [NEG_RISK_CTF_EXCHANGE_ADDRESS]: "Neg Risk CTF Exchange",
  [CTF_EXCHANGE_V2_ADDRESS]: "CTF Exchange v2",
};

const TOPIC_LABELS: Record<string, string> = {
  [TOPIC_ORDER_FILLED_V1]: "OrderFilled(v1)",
  [TOPIC_ORDER_FILLED_NEG_RISK]: "OrderFilled(negRisk)",
  [TOPIC_ORDERS_MATCHED_NEG_RISK]: "OrdersMatched(negRisk)",
  [TOPIC_POSITION_SPLIT]: "PositionSplit",
  [TOPIC_POSITIONS_MERGE]: "PositionsMerge",
  [TOPIC_PAYOUT_REDEMPTION]: "PayoutRedemption",
  [TOPIC_PROXY_WALLET_EXECUTION]: "ProxyWalletExecution",
};

type ApiRow = (ActivityApiRow | TradeApiRow) & {
  transactionHash?: string;
  timestamp?: number;
  type?: string;
  side?: string;
  asset?: string;
  conditionId?: string;
  proxyWallet?: string;
};

interface ReceiptTrace {
  txHash: string;
  blockNumber: number | null;
  timestamp: number | null;
  apiTimestamp: number | null;
  apiType: string;
  apiSide: string;
  emitters: string[];
  topic0s: string[];
  orderFilledLogs: Array<{
    contract: string;
    exchangeLabel: string;
    topic0: string;
    maker: string | null;
    taker: string | null;
    walletRole: string;
  }>;
  otherEventTypes: string[];
  walletInvolvement: string;
  inIndexedSet: boolean;
  etherscanGetLogs: string;
}

function parseArgs(): { wallet: string; receiptSample: number; getLogsSample: number } {
  let wallet = DEFAULT_WALLET;
  let receiptSample = 20;
  let getLogsSample = 20;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--wallet" && argv[i + 1]) wallet = argv[++i].toLowerCase();
    if (argv[i] === "--receipt-sample" && argv[i + 1]) {
      receiptSample = Number(argv[++i]);
    }
    if (argv[i] === "--getlogs-sample" && argv[i + 1]) {
      getLogsSample = Number(argv[++i]);
    }
  }
  return { wallet, receiptSample, getLogsSample };
}

function monthKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function loadFullHistoryLogs(wallet: string, fromBlock: number, toBlock: number): RpcLog[] {
  const dir = join(process.cwd(), "tmp", "wallet-indexed-audit", "checkpoints");
  const prefix = `etherscan_v2|${wallet}|`;
  const suffix = `|${fromBlock}|${toBlock}|`;
  const files = readdirSync(dir).filter(
    (f) => f.startsWith(prefix) && f.includes(suffix)
  );
  const logs: RpcLog[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const key = file.replace(/\.json$/, "");
    const cp = readEtherscanCheckpoint(key);
    if (!cp?.logs?.length) continue;
    for (const log of cp.logs) {
      const k = `${log.transactionHash}:${log.logIndex}`;
      if (seen.has(k)) continue;
      seen.add(k);
      logs.push(log);
    }
  }
  return logs;
}

function classifyWalletRole(
  wallet: string,
  maker: string | null,
  taker: string | null
): string {
  const w = wallet.toLowerCase();
  const roles: string[] = [];
  if (maker === w) roles.push("maker");
  if (taker === w) roles.push("taker");
  if (roles.length === 0) return "neither";
  return roles.join("+");
}

function traceReceipt(
  txHash: string,
  wallet: string,
  rpc: PolygonRpcClient,
  row: ApiRow,
  indexedTxSet: Set<string>
): Promise<ReceiptTrace> {
  return (async () => {
    const receipt = await rpc.getTransactionReceipt(txHash);
    const blockNumber = receipt?.blockNumber
      ? Number.parseInt(receipt.blockNumber, 16)
      : null;
    const timestamp =
      blockNumber != null ? await rpc.getBlockTimestamp(blockNumber) : null;

    const orderFilledLogs: ReceiptTrace["orderFilledLogs"] = [];
    const emitters = new Set<string>();
    const topic0s = new Set<string>();
    const otherEventTypes = new Set<string>();

    for (const log of receipt?.logs ?? []) {
      emitters.add(log.address.toLowerCase());
      const t0 = log.topics[0]?.toLowerCase();
      if (t0) topic0s.add(t0);

      const v1 = decodeOrderFilledV1(log);
      const neg = decodeOrderFilledNegRisk(log);
      const fill = v1 ?? neg;
      if (fill) {
        orderFilledLogs.push({
          contract: fill.contractAddress,
          exchangeLabel: EXCHANGE_LABELS[fill.contractAddress] ?? fill.contractAddress,
          topic0: log.topics[0] ?? "",
          maker: fill.maker,
          taker: fill.taker,
          walletRole: classifyWalletRole(wallet, fill.maker, fill.taker),
        });
        continue;
      }

      const parsed = decodeLog(log);
      if (parsed.type !== "unparsed") {
        otherEventTypes.add(parsed.type);
      } else if (t0 && TOPIC_LABELS[t0]) {
        otherEventTypes.add(TOPIC_LABELS[t0]);
      } else {
        otherEventTypes.add("unknown");
      }
    }

    let walletInvolvement = "no_receipt";
    if (receipt) {
      if (orderFilledLogs.some((l) => l.walletRole !== "neither")) {
        walletInvolvement = orderFilledLogs
          .filter((l) => l.walletRole !== "neither")
          .map((l) => `order_filled:${l.walletRole}`)
          .join("; ");
      } else if (otherEventTypes.has("payout_redemption")) {
        walletInvolvement = "payout_redemption";
      } else if (otherEventTypes.has("position_split")) {
        walletInvolvement = "position_split";
      } else if (otherEventTypes.has("positions_merge")) {
        walletInvolvement = "positions_merge";
      } else if (otherEventTypes.has("erc1155_transfer")) {
        walletInvolvement = "erc1155_transfer";
      } else if (otherEventTypes.has("ProxyWalletExecution")) {
        walletInvolvement = "proxy_execution";
      } else {
        walletInvolvement = "no_wallet_execution_match";
      }
    }

    return {
      txHash,
      blockNumber,
      timestamp,
      apiTimestamp: row.timestamp ?? null,
      apiType: (row.type ?? "TRADE").toUpperCase(),
      apiSide: (row.side ?? "").toUpperCase(),
      emitters: [...emitters],
      topic0s: [...topic0s],
      orderFilledLogs,
      otherEventTypes: [...otherEventTypes],
      walletInvolvement,
      inIndexedSet: indexedTxSet.has(txHash.toLowerCase()),
      etherscanGetLogs: "pending",
    };
  })();
}

async function testEtherscanGetLogs(
  provider: EtherscanV2LogProvider,
  wallet: string,
  log: RpcLog,
  fromBlock: number,
  toBlock: number
): Promise<string> {
  const topic0 = log.topics[0];
  const maker = topicToAddress(log.topics[2]);
  const taker = topicToAddress(log.topics[3]);
  const w = wallet.toLowerCase();

  const queries: Array<{ role: string; topics: (string | null)[] }> = [];
  if (maker === w) {
    queries.push({
      role: "maker",
      topics: [topic0, null, walletTopic(wallet)],
    });
  }
  if (taker === w) {
    queries.push({
      role: "taker",
      topics: [topic0, null, null, walletTopic(wallet)],
    });
  }
  if (queries.length === 0) {
    return "C_wallet_not_maker_or_taker";
  }

  for (const q of queries) {
    const logs = await provider.getLogs({
      fromBlock,
      toBlock,
      address: log.address,
      topics: q.topics,
    });
    const hit = logs.some(
      (l) =>
        l.transactionHash.toLowerCase() === log.transactionHash.toLowerCase() &&
        l.logIndex === log.logIndex
    );
    if (hit) return `A_etherscan_returns_${q.role}_query`;
  }
  return "B_etherscan_does_not_return_wallet_filtered_log";
}

async function main(): Promise<void> {
  const { wallet, receiptSample, getLogsSample } = parseArgs();
  const rpc = new PolygonRpcClient();
  const provider = new EtherscanV2LogProvider();

  console.error(`[reconcile] wallet=${wallet} scan=${SCAN_FROM}→${SCAN_TO}`);

  const [activity, trades] = await Promise.all([
    fetchActivityHistory(wallet, { interPageDelayMs: 50 }),
    fetchTradeHistory(wallet, { interPageDelayMs: 50 }),
  ]);

  const apiEvents = deduplicateLedgerEvents(
    normalizeActivityRows(activity.rows, wallet),
    normalizeTradeRows(trades.rows, wallet)
  );

  const apiRows: ApiRow[] = [];
  for (const row of activity.rows) apiRows.push(row);
  for (const row of trades.rows) apiRows.push(row);

  const apiTxHashes = [
    ...new Set(
      apiEvents.map((e) => e.txHash?.toLowerCase()).filter(Boolean) as string[]
    ),
  ];

  const tradeApiRows = apiRows.filter((r) => {
    const t = (r.type ?? "TRADE").toUpperCase();
    return t === "TRADE" || r.side != null;
  });
  const tradeApiTxHashes = [
    ...new Set(
      tradeApiRows
        .map((r) => r.transactionHash?.toLowerCase())
        .filter(Boolean) as string[]
    ),
  ];

  console.error(`[reconcile] loading indexed logs from checkpoints...`);
  const indexedLogs = loadFullHistoryLogs(wallet, SCAN_FROM, SCAN_TO);
  const dedupedLogs = dedupeLogs(indexedLogs);

  const blockNumbers = new Set<number>();
  for (const log of dedupedLogs) {
    blockNumbers.add(Number.parseInt(log.blockNumber, 16));
  }
  const blockTimestamps = new Map<number, number>();
  for (const block of blockNumbers) {
    const ts = await rpc.getBlockTimestamp(block);
    if (ts) blockTimestamps.set(block, ts);
  }

  const { events: indexedEvents } = parsedEventsToLedgerEvents(
    dedupedLogs.map((l) => decodeLog(l)),
    wallet,
    blockTimestamps
  );

  const indexedTxHashes = [
    ...new Set(
      indexedEvents.map((e) => e.txHash?.toLowerCase()).filter(Boolean) as string[]
    ),
  ];
  const indexedTxSet = new Set(indexedTxHashes);
  const indexedOrderFilledTxSet = new Set(
    indexedEvents
      .filter((e) => e.type === "BUY" || e.type === "SELL")
      .map((e) => e.txHash?.toLowerCase())
      .filter(Boolean) as string[]
  );

  const missingApiTx = apiTxHashes.filter((tx) => !indexedTxSet.has(tx));
  const missingTradeApiTx = tradeApiTxHashes.filter((tx) => !indexedOrderFilledTxSet.has(tx));

  const matched = apiTxHashes.length - missingApiTx.length;
  const overlapPct = apiTxHashes.length
    ? (matched / apiTxHashes.length) * 100
    : 0;

  console.log("\n=== 1. MISSING TX SET ===");
  console.log(`total API tx (all event types): ${apiTxHashes.length}`);
  console.log(`matched (indexed ledger tx overlap): ${matched}`);
  console.log(`missing: ${missingApiTx.length}`);
  console.log(`missing %: ${((missingApiTx.length / apiTxHashes.length) * 100).toFixed(2)}%`);
  console.log(`trade-only API tx: ${tradeApiTxHashes.length}`);
  console.log(`missing trade API tx (vs indexed BUY/SELL): ${missingTradeApiTx.length}`);

  const missingRows = apiRows.filter(
    (r) =>
      r.transactionHash &&
      missingApiTx.includes(r.transactionHash.toLowerCase())
  );
  const byMonth = new Map<string, number>();
  const byType = new Map<string, number>();
  const bySide = new Map<string, number>();
  const byMarket = new Map<string, number>();
  let earliest = Infinity;
  let latest = 0;
  let earliestRow: ApiRow | null = null;

  for (const row of missingRows) {
    const ts = Number(row.timestamp ?? 0);
    if (ts > 0) {
      byMonth.set(monthKey(ts), (byMonth.get(monthKey(ts)) ?? 0) + 1);
      if (ts < earliest) {
        earliest = ts;
        earliestRow = row;
      }
      latest = Math.max(latest, ts);
    }
    const type = (row.type ?? "TRADE").toUpperCase();
    byType.set(type, (byType.get(type) ?? 0) + 1);
    const side = (row.side ?? "unknown").toUpperCase();
    bySide.set(side, (bySide.get(side) ?? 0) + 1);
    const market = row.conditionId ?? row.asset ?? "unknown";
    byMarket.set(market, (byMarket.get(market) ?? 0) + 1);
  }

  console.log("\nMissing by API row type:");
  for (const [k, v] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  console.log("\nMissing by month (top 10):");
  for (const [k, v] of [...byMonth.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`\nMissing timestamp range: ${earliest} → ${latest}`);

  const missingWithTs = [
    ...new Map(
      missingRows
        .filter((r) => r.transactionHash && r.timestamp)
        .map((r) => [r.transactionHash!.toLowerCase(), r])
    ).values(),
  ].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

  console.log(`\n=== 2. EARLIEST ${receiptSample} MISSING API TX RECEIPTS ===`);
  const receiptTraces: ReceiptTrace[] = [];
  for (const row of missingWithTs.slice(0, receiptSample)) {
    const tx = row.transactionHash!.toLowerCase();
    const trace = await traceReceipt(tx, wallet, rpc, row, indexedTxSet);
    receiptTraces.push(trace);
    console.log(`\n${tx}`);
    console.log(`  api: type=${trace.apiType} side=${trace.apiSide} ts=${trace.apiTimestamp}`);
    console.log(`  block=${trace.blockNumber} chain_ts=${trace.timestamp}`);
    console.log(`  wallet_involvement=${trace.walletInvolvement}`);
    console.log(`  orderFilled=${trace.orderFilledLogs.length} other=${trace.otherEventTypes.join(",")}`);
    for (const ofl of trace.orderFilledLogs) {
      console.log(
        `    ${ofl.exchangeLabel} maker=${ofl.maker} taker=${ofl.taker} role=${ofl.walletRole}`
      );
    }
    if (trace.orderFilledLogs.length === 0) {
      console.log(`  emitters=${trace.emitters.slice(0, 5).join(", ")}`);
      console.log(
        `  topic0s=${trace.topic0s
          .slice(0, 5)
          .map((t) => TOPIC_LABELS[t] ?? t.slice(0, 10))
          .join(", ")}`
      );
    }
  }

  console.log("\n=== 3. UNKNOWN CONTRACTS IN MISSING RECEIPTS ===");
  const unknownContracts = new Map<
    string,
    { count: number; topic0: string; minBlock: number; maxBlock: number; txs: Set<string> }
  >();
  for (const trace of receiptTraces) {
    for (const ofl of trace.orderFilledLogs) {
      if (EXCHANGE_LABELS[ofl.contract]) continue;
      const cur = unknownContracts.get(ofl.contract) ?? {
        count: 0,
        topic0: ofl.topic0,
        minBlock: Infinity,
        maxBlock: 0,
        txs: new Set<string>(),
      };
      cur.count += 1;
      cur.txs.add(trace.txHash);
      if (trace.blockNumber != null) {
        cur.minBlock = Math.min(cur.minBlock, trace.blockNumber);
        cur.maxBlock = Math.max(cur.maxBlock, trace.blockNumber);
      }
      unknownContracts.set(ofl.contract, cur);
    }
    for (const emitter of trace.emitters) {
      if (
        EXCHANGE_ADDRESSES.includes(emitter as (typeof EXCHANGE_ADDRESSES)[number]) ||
        emitter === CONDITIONAL_TOKENS_ADDRESS
      ) {
        continue;
      }
      if (trace.orderFilledLogs.length > 0) continue;
      const cur = unknownContracts.get(emitter) ?? {
        count: 0,
        topic0: trace.topic0s[0] ?? "",
        minBlock: trace.blockNumber ?? 0,
        maxBlock: trace.blockNumber ?? 0,
        txs: new Set<string>(),
      };
      cur.count += 1;
      cur.txs.add(trace.txHash);
      unknownContracts.set(emitter, cur);
    }
  }
  if (unknownContracts.size === 0) {
    console.log("  (none in earliest-missing sample)");
  } else {
    for (const [addr, info] of unknownContracts) {
      console.log(
        `  ${addr} txs=${info.txs.size} topic0=${TOPIC_LABELS[info.topic0] ?? info.topic0} blocks=${info.minBlock}-${info.maxBlock}`
      );
    }
  }

  console.log("\n=== 4. WALLET IDENTITY CANDIDATES (from missing receipts) ===");
  const relatedAddresses = new Map<string, Set<string>>();
  for (const trace of receiptTraces) {
    for (const ofl of trace.orderFilledLogs) {
      for (const addr of [ofl.maker, ofl.taker]) {
        if (!addr || addr === wallet) continue;
        const set = relatedAddresses.get(addr) ?? new Set<string>();
        set.add(trace.txHash);
        relatedAddresses.set(addr, set);
      }
    }
    for (const row of missingRows.filter(
      (r) => r.transactionHash?.toLowerCase() === trace.txHash
    )) {
      const proxy = row.proxyWallet?.toLowerCase();
      if (proxy && proxy !== wallet) {
        const set = relatedAddresses.get(proxy) ?? new Set<string>();
        set.add(trace.txHash);
        relatedAddresses.set(proxy, set);
      }
    }
  }
  if (relatedAddresses.size === 0) {
    console.log("  (no counterparty/proxy candidates in sample)");
  } else {
    for (const [addr, txs] of [...relatedAddresses.entries()].sort(
      (a, b) => b[1].size - a[1].size
    )) {
      console.log(`  ${addr} evidence_txs=${txs.size}`);
    }
  }

  console.log("\n=== 5. DATA API SEMANTICS (all missing) ===");
  const allMissingByOnChain = new Map<string, number>();
  for (const tx of missingApiTx) {
    const row = missingRows.find((r) => r.transactionHash?.toLowerCase() === tx);
    const apiType = (row?.type ?? "TRADE").toUpperCase();
    allMissingByOnChain.set(apiType, (allMissingByOnChain.get(apiType) ?? 0) + 1);
  }
  for (const [k, v] of [...allMissingByOnChain.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  API type ${k}: ${v} missing tx hashes`);
  }

  const receiptClass = new Map<string, number>();
  for (const trace of receiptTraces) {
    const key =
      trace.orderFilledLogs.length > 0
        ? `order_filled_${trace.orderFilledLogs[0].walletRole}`
        : trace.walletInvolvement;
    receiptClass.set(key, (receiptClass.get(key) ?? 0) + 1);
  }
  console.log("\nEarliest-missing receipt classes:");
  for (const [k, v] of receiptClass) console.log(`  ${k}: ${v}`);

  console.log(`\n=== 6. ETHERSCAN getLogs SPOT CHECK (${getLogsSample} missing OrderFilled) ===`);
  const orderFilledMissing = receiptTraces.filter((t) => t.orderFilledLogs.length > 0);
  const getLogsTargets = orderFilledMissing.slice(0, getLogsSample);
  for (const trace of getLogsTargets) {
    const receipt = await rpc.getTransactionReceipt(trace.txHash);
    const ofLog = (receipt?.logs ?? []).find((log) => {
      const v1 = decodeOrderFilledV1(log);
      const neg = decodeOrderFilledNegRisk(log);
      return Boolean(v1 ?? neg);
    });
    if (!ofLog) continue;
    const block = Number.parseInt(ofLog.blockNumber, 16);
    const verdict = await testEtherscanGetLogs(
      provider,
      wallet,
      ofLog,
      Math.max(SCAN_FROM, block - 5),
      block + 5
    );
    trace.etherscanGetLogs = verdict;
    console.log(`  ${trace.txHash.slice(0, 14)}… ${verdict}`);
  }

  console.log("\n=== 7. OLDEST API TX RECONCILIATION ===");
  const allApiWithTs = apiRows
    .filter((r) => r.transactionHash && r.timestamp)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const oldestApi = allApiWithTs[0];
  const oldestTx = oldestApi?.transactionHash?.toLowerCase() ?? "";
  const oldestInIndexed = indexedTxSet.has(oldestTx);
  console.log(`API oldest tx: ${oldestTx}`);
  console.log(`  timestamp: ${oldestApi?.timestamp} (${new Date(Number(oldestApi?.timestamp) * 1000).toISOString()})`);
  console.log(`  type: ${oldestApi?.type} side: ${oldestApi?.side}`);
  console.log(`  asset: ${oldestApi?.asset?.slice(0, 20)}…`);
  console.log(`  recovered in indexed set: ${oldestInIndexed ? "YES" : "NO"}`);

  if (!oldestInIndexed && oldestTx) {
    const oldestTrace = await traceReceipt(
      oldestTx,
      wallet,
      rpc,
      oldestApi,
      indexedTxSet
    );
    console.log(`  chain block: ${oldestTrace.blockNumber}`);
    console.log(`  wallet involvement: ${oldestTrace.walletInvolvement}`);
    for (const ofl of oldestTrace.orderFilledLogs) {
      console.log(
        `  OrderFilled ${ofl.exchangeLabel} maker=${ofl.maker} taker=${ofl.taker} role=${ofl.walletRole}`
      );
    }
    if (oldestTrace.orderFilledLogs.length > 0) {
      const receipt = await rpc.getTransactionReceipt(oldestTx);
      const ofLog = (receipt?.logs ?? []).find((log) => decodeOrderFilledV1(log) ?? decodeOrderFilledNegRisk(log));
      if (ofLog) {
        const block = Number.parseInt(ofLog.blockNumber, 16);
        const verdict = await testEtherscanGetLogs(
          provider,
          wallet,
          ofLog,
          SCAN_FROM,
          SCAN_TO
        );
        console.log(`  full-range Etherscan getLogs: ${verdict}`);
      }
    }
  }

  console.log("\n=== 8. COMPLETENESS VERDICT ===");
  const neitherCount = receiptTraces.filter((t) =>
    t.orderFilledLogs.some((o) => o.walletRole === "neither")
  ).length;
  const noOrderFilled = receiptTraces.filter((t) => t.orderFilledLogs.length === 0).length;
  const makerOnlyMissing = receiptTraces.filter(
    (t) =>
      t.orderFilledLogs.length > 0 &&
      t.orderFilledLogs.every((o) => o.walletRole === "neither")
  ).length;
  const etherscanReturns = getLogsTargets.filter((t) =>
    t.etherscanGetLogs.startsWith("A_")
  ).length;
  const etherscanMiss = getLogsTargets.filter((t) =>
    t.etherscanGetLogs.startsWith("B_")
  ).length;

  console.log(`Revised overlap: ${overlapPct.toFixed(2)}% (${matched}/${apiTxHashes.length})`);
  console.log(`Earliest-missing sample: no OrderFilled=${noOrderFilled}/${receiptTraces.length}`);
  console.log(`Earliest-missing: wallet neither maker/taker=${makerOnlyMissing}`);
  console.log(`Etherscan spot-check returns=${etherscanReturns} miss=${etherscanMiss}`);

  const report = {
    wallet,
    scan: { fromBlock: SCAN_FROM, toBlock: SCAN_TO },
    api: {
      totalTx: apiTxHashes.length,
      tradeTx: tradeApiTxHashes.length,
      matched,
      missing: missingApiTx.length,
      missingPct: (missingApiTx.length / apiTxHashes.length) * 100,
      missingTradeTx: missingTradeApiTx.length,
      overlapPct,
      byType: Object.fromEntries(byType),
      byMonth: Object.fromEntries(byMonth),
    },
    indexed: {
      rawLogs: dedupedLogs.length,
      ledgerEvents: indexedEvents.length,
      uniqueTx: indexedTxHashes.length,
      orderFilledTx: indexedOrderFilledTxSet.size,
    },
    oldestApi: {
      txHash: oldestTx,
      timestamp: oldestApi?.timestamp,
      recovered: oldestInIndexed,
    },
    receiptTraces,
    verdict: {
      primary:
        noOrderFilled > receiptTraces.length / 2
          ? "D_data_api_non_orderfilled"
          : makerOnlyMissing > 0
            ? "B_identity_or_counterparty"
            : etherscanMiss > etherscanReturns
              ? "E_etherscan_index_gap"
              : "F_combination",
      neitherCount,
      noOrderFilled,
      etherscanReturns,
      etherscanMiss,
    },
  };

  const outDir = join(process.cwd(), "tmp", "wallet-indexed-audit");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(
    outDir,
    `reconcile-missing-${wallet.slice(2, 10)}-${Date.now()}.json`
  );
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nJSON report: ${outPath}`);
}

void main().catch((err) => {
  console.error("[reconcile] failed:", err);
  process.exit(1);
});
