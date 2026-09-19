#!/usr/bin/env tsx
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import { buildWalletLogQueries } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import { fetchActivityHistory, fetchTradeHistory } from "@/lib/walletLedger/fetchers";
import {
  deduplicateLedgerEvents,
  normalizeActivityRows,
  normalizeTradeRows,
} from "@/lib/walletLedger/normalize";
import {
  CTF_EXCHANGE_LEGACY_ADDRESS,
  CTF_EXCHANGE_V1_ADDRESS,
  CTF_EXCHANGE_V2_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  TOPIC_ORDER_FILLED_NEG_RISK,
  TOPIC_ORDER_FILLED_V1,
} from "@/lib/walletLedger/onchain/contracts";
import {
  decodeLog,
  decodeOrderFilledNegRisk,
  decodeOrderFilledV1,
} from "@/lib/walletLedger/onchain/decode";
import { parsedEventsToLedgerEvents } from "@/lib/walletLedger/onchain/normalize";
import { PolygonRpcClient, dedupeLogs } from "@/lib/walletLedger/onchain/rpc";
import type { ActivityApiRow, TradeApiRow } from "@/lib/walletLedger/types";

const WALLET = (
  process.argv.find((_, i, a) => a[i - 1] === "--wallet") ??
  "0x7e5972bfc25819775ee5a9d4f191919375487b8b"
).toLowerCase();
const FROM = Number(
  process.argv.find((_, i, a) => a[i - 1] === "--from-block") ?? "90847885"
);
const TO = Number(
  process.argv.find((_, i, a) => a[i - 1] === "--to-block") ?? "92847885"
);

const EXCHANGE_LABELS: Record<string, string> = {
  [CTF_EXCHANGE_LEGACY_ADDRESS]: "legacy",
  [CTF_EXCHANGE_V1_ADDRESS]: "v1",
  [NEG_RISK_CTF_EXCHANGE_ADDRESS]: "neg_risk",
  [CTF_EXCHANGE_V2_ADDRESS]: "v2",
};

async function fetchIndexedTxHashes(): Promise<Set<string>> {
  const provider = new EtherscanV2LogProvider();
  const queries = buildWalletLogQueries(WALLET, FROM, TO);
  const logs = [];
  for (const query of queries) {
    const { logs: batch } = await provider.getLogsPaginated(query, {
      resumeCheckpoint: false,
    });
    logs.push(...batch);
  }
  const deduped = dedupeLogs(logs);
  const blockTs = new Map<number, number>();
  for (const log of deduped) {
    blockTs.set(Number.parseInt(log.blockNumber, 16), 1);
  }
  const { events } = parsedEventsToLedgerEvents(
    deduped.map((l) => decodeLog(l)),
    WALLET,
    blockTs
  );
  const map = new Map<string, (typeof events)[0]>();
  for (const e of events) map.set(e.dedupeKey, e);
  return new Set(
    [...map.values()].map((e) => e.txHash?.toLowerCase()).filter(Boolean) as string[]
  );
}

function primaryApiType(
  rows: Array<ActivityApiRow | TradeApiRow>,
  tx: string
): string {
  const matches = rows.filter((r) => r.transactionHash?.toLowerCase() === tx);
  const types = [...new Set(matches.map((r) => (r.type ?? "TRADE").toUpperCase()))];
  if (types.includes("TRADE")) return "TRADE";
  if (types.includes("REDEEM")) return "REDEEM";
  if (types.includes("MERGE")) return "MERGE";
  if (types.includes("SPLIT")) return "SPLIT";
  return types[0] ?? "OTHER";
}

async function main(): Promise<void> {
  console.error("[reconcile] fetching API history...");
  const [activity, trades] = await Promise.all([
    fetchActivityHistory(WALLET, { interPageDelayMs: 50 }),
    fetchTradeHistory(WALLET, { interPageDelayMs: 50 }),
  ]);

  const apiEvents = deduplicateLedgerEvents(
    normalizeActivityRows(activity.rows, WALLET),
    normalizeTradeRows(trades.rows, WALLET)
  );
  const apiTx = [
    ...new Set(
      apiEvents.map((e) => e.txHash?.toLowerCase()).filter(Boolean) as string[]
    ),
  ];

  console.error("[reconcile] fetching indexed logs via Etherscan...");
  const indexedTx = await fetchIndexedTxHashes();
  const missing = apiTx.filter((tx) => !indexedTx.has(tx));

  const rows: Array<ActivityApiRow | TradeApiRow> = [
    ...activity.rows,
    ...trades.rows,
  ];
  const byType = new Map<string, number>();
  for (const tx of missing) {
    const primary = primaryApiType(rows, tx);
    byType.set(primary, (byType.get(primary) ?? 0) + 1);
  }

  console.log("\n=== MISSING TX BREAKDOWN ===");
  console.log(`wallet=${WALLET} scan=${FROM}→${TO}`);
  console.log(`API tx hashes: ${apiTx.length}`);
  console.log(`matched: ${apiTx.length - missing.length}`);
  console.log(`missing: ${missing.length}`);
  console.log(
    `overlap %: ${(((apiTx.length - missing.length) / apiTx.length) * 100).toFixed(2)}%`
  );
  console.log("by type:", Object.fromEntries(byType));

  const rpc = new PolygonRpcClient();
  const tradeMissing = missing.filter((tx) => primaryApiType(rows, tx) === "TRADE");
  const unexplained: string[] = [];
  const reasonCounts = new Map<string, number>();

  console.log(`\n=== TRADE RECEIPT INSPECTION (${tradeMissing.length}) ===`);
  for (const tx of tradeMissing) {
    const receipt = await rpc.getTransactionReceipt(tx);
    const fills: string[] = [];
    let walletRole = "none";
    for (const log of receipt?.logs ?? []) {
      const fill = decodeOrderFilledV1(log) ?? decodeOrderFilledNegRisk(log);
      if (!fill) continue;
      const role =
        fill.maker === WALLET ? "maker" : fill.taker === WALLET ? "taker" : "neither";
      if (role !== "neither") walletRole = role;
      const label = EXCHANGE_LABELS[fill.contractAddress] ?? fill.contractAddress;
      const topic =
        log.topics[0] === TOPIC_ORDER_FILLED_V1 ? "OrderFilled_v1" : "OrderFilled_negRisk";
      fills.push(`${label}/${topic}/${role}`);
    }
    const block = receipt?.blockNumber
      ? Number.parseInt(receipt.blockNumber, 16)
      : null;
    const inScan =
      block != null && block >= FROM && block <= TO ? "in_scan" : "outside_scan";
    let reason: string;
    if (fills.length === 0) reason = "no_order_filled_in_receipt";
    else if (walletRole === "neither") reason = "wallet_not_maker_or_taker";
    else if (inScan === "outside_scan") reason = "tx_outside_indexed_block_window";
    else reason = "unexplained_missing_orderfilled";

    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    if (reason === "unexplained_missing_orderfilled") unexplained.push(tx);
  }
  console.log("trade missing reasons:", Object.fromEntries(reasonCounts));
  console.log(`\nunexplained missing TRADE txs: ${unexplained.length}`);
  if (unexplained.length > 0 && unexplained.length <= 20) {
    for (const tx of unexplained) console.log(`  ${tx}`);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
