#!/usr/bin/env tsx
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { fetchActivityHistory, fetchTradeHistory } from "@/lib/walletLedger/fetchers";
import {
  deduplicateLedgerEvents,
  normalizeActivityRows,
  normalizeTradeRows,
} from "@/lib/walletLedger/normalize";
import {
  decodeLog,
  decodeOrderFilledNegRisk,
  decodeOrderFilledV1,
} from "@/lib/walletLedger/onchain/decode";
import { parsedEventsToLedgerEvents } from "@/lib/walletLedger/onchain/normalize";
import { PolygonRpcClient, dedupeLogs } from "@/lib/walletLedger/onchain/rpc";
import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import { walletTopic } from "@/lib/walletLedger/onchain/rpc";
import { TOPIC_ORDER_FILLED_V1 } from "@/lib/walletLedger/onchain/contracts";

const WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";
const LEGACY_EXCHANGE = "0xc5d563a36ae78145c45a50134d48a1215220f80a";
const SCAN_FROM = 57_000_000;
const SCAN_TO = 92_831_448;

async function main(): Promise<void> {
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
  ].sort();

  const dir = join(process.cwd(), "tmp", "wallet-indexed-audit", "checkpoints");
  const logs = [];
  const seen = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.includes("0562") || !f.includes("57000000|92831448")) continue;
    const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
      logs: typeof logs;
    };
    for (const l of j.logs ?? []) {
      const k = `${l.transactionHash}:${l.logIndex}`;
      if (seen.has(k)) continue;
      seen.add(k);
      logs.push(l);
    }
  }

  const rpc = new PolygonRpcClient();
  const blockTs = new Map<number, number>();
  for (const l of logs) {
    const b = Number.parseInt(l.blockNumber, 16);
    if (!blockTs.has(b)) {
      const t = await rpc.getBlockTimestamp(b);
      if (t) blockTs.set(b, t);
    }
  }
  const { events } = parsedEventsToLedgerEvents(
    dedupeLogs(logs).map((l) => decodeLog(l)),
    WALLET,
    blockTs
  );
  const indexedTx = new Set(
    events.map((e) => e.txHash?.toLowerCase()).filter(Boolean) as string[]
  );

  // Use audit-known overlap as ground truth when checkpoints incomplete
  const auditOverlap = 7649;
  const auditMissing = apiTx.length - auditOverlap;

  const missing = apiTx.filter((tx) => !indexedTx.has(tx));
  console.log("checkpoint indexed txs:", indexedTx.size);
  console.log("api txs:", apiTx.length);
  console.log("checkpoint missing:", missing.length);
  console.log("audit missing (expected):", auditMissing);

  const rows = [...activity.rows, ...trades.rows].filter((r) => r.transactionHash);
  const missingRows = rows
    .filter((r) => missing.includes(r.transactionHash!.toLowerCase()))
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const earliestByTx = new Map<string, (typeof rows)[0]>();
  for (const r of missingRows) {
    const tx = r.transactionHash!.toLowerCase();
    if (!earliestByTx.has(tx)) earliestByTx.set(tx, r);
  }
  const earliestMissing = [...earliestByTx.entries()].sort(
    (a, b) => Number(a[1].timestamp) - Number(b[1].timestamp)
  );

  const byContract = new Map<string, number>();
  const byApiType = new Map<string, number>();
  let orderFilledMissing = 0;
  let legacyExchangeMissing = 0;
  let walletNeither = 0;

  const sampleSize = Math.min(200, earliestMissing.length);
  for (const [tx, row] of earliestMissing.slice(0, sampleSize)) {
    const apiType = (row.type ?? "TRADE").toUpperCase();
    byApiType.set(apiType, (byApiType.get(apiType) ?? 0) + 1);
    const receipt = await rpc.getTransactionReceipt(tx);
    let foundOf = false;
    for (const log of receipt?.logs ?? []) {
      const fill = decodeOrderFilledV1(log) ?? decodeOrderFilledNegRisk(log);
      if (!fill) continue;
      foundOf = true;
      orderFilledMissing += 1;
      byContract.set(fill.contractAddress, (byContract.get(fill.contractAddress) ?? 0) + 1);
      if (fill.contractAddress === LEGACY_EXCHANGE) legacyExchangeMissing += 1;
      if (fill.maker !== WALLET && fill.taker !== WALLET) walletNeither += 1;
    }
    if (!foundOf) byContract.set("(no_order_filled)", (byContract.get("(no_order_filled)") ?? 0) + 1);
  }

  console.log("\n=== sample", sampleSize, "chronologically earliest missing ===");
  console.log("by API type:", Object.fromEntries(byApiType));
  console.log("by OrderFilled contract:", Object.fromEntries(byContract));
  console.log("orderFilled in sample:", orderFilledMissing);
  console.log("legacy exchange 0xc5d563…:", legacyExchangeMissing);

  const provider = new EtherscanV2LogProvider();
  const oldestTx = earliestMissing[0]?.[0];
  if (oldestTx) {
    const receipt = await rpc.getTransactionReceipt(oldestTx);
    const ofLog = receipt?.logs.find((l) => decodeOrderFilledV1(l) ?? decodeOrderFilledNegRisk(l));
    if (ofLog) {
      const block = Number.parseInt(ofLog.blockNumber, 16);
      const legacyLogs = await provider.getLogs({
        fromBlock: SCAN_FROM,
        toBlock: SCAN_TO,
        address: LEGACY_EXCHANGE,
        topics: [TOPIC_ORDER_FILLED_V1, null, null, walletTopic(WALLET)],
      });
      const hit = legacyLogs.some((l) => l.transactionHash.toLowerCase() === oldestTx);
      console.log("\noldest API tx:", oldestTx);
      console.log("block:", block, "contract:", ofLog.address);
      console.log("Etherscan legacy-exchange taker query returns oldest tx:", hit);
      console.log("legacy query total logs:", legacyLogs.length);
    }
  }
}

void main();
