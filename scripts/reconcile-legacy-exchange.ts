#!/usr/bin/env tsx
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import { fetchActivityHistory, fetchTradeHistory } from "@/lib/walletLedger/fetchers";
import {
  deduplicateLedgerEvents,
  normalizeActivityRows,
  normalizeTradeRows,
} from "@/lib/walletLedger/normalize";
import {
  CTF_EXCHANGE_V1_ADDRESS,
  CTF_EXCHANGE_V2_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  TOPIC_ORDER_FILLED_NEG_RISK,
  TOPIC_ORDER_FILLED_V1,
} from "@/lib/walletLedger/onchain/contracts";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import { walletTopic } from "@/lib/walletLedger/onchain/rpc";
import {
  decodeOrderFilledNegRisk,
  decodeOrderFilledV1,
} from "@/lib/walletLedger/onchain/decode";

const WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";
const LEGACY_EXCHANGE = "0xc5d563a36ae78145c45a50134d48a1215220f80a";
const FROM = 57_000_000;
const TO = 92_831_448;

async function fetchAll(
  provider: EtherscanV2LogProvider,
  address: string,
  topics: (string | null)[]
) {
  const { logs } = await provider.getLogsPaginated(
    { fromBlock: FROM, toBlock: TO, address, topics },
    { resumeCheckpoint: false }
  );
  return logs;
}

async function main(): Promise<void> {
  const provider = new EtherscanV2LogProvider();
  const [activity, trades] = await Promise.all([
    fetchActivityHistory(WALLET, { interPageDelayMs: 50 }),
    fetchTradeHistory(WALLET, { interPageDelayMs: 50 }),
  ]);
  const apiEvents = deduplicateLedgerEvents(
    normalizeActivityRows(activity.rows, WALLET),
    normalizeTradeRows(trades.rows, WALLET)
  );
  const apiTx = new Set(
    apiEvents.map((e) => e.txHash?.toLowerCase()).filter(Boolean) as string[]
  );

  const makerV1 = [TOPIC_ORDER_FILLED_V1, null, walletTopic(WALLET)];
  const takerV1 = [TOPIC_ORDER_FILLED_V1, null, null, walletTopic(WALLET)];
  const makerNeg = [TOPIC_ORDER_FILLED_NEG_RISK, null, walletTopic(WALLET)];
  const takerNeg = [TOPIC_ORDER_FILLED_NEG_RISK, null, null, walletTopic(WALLET)];

  const queries = [
    ["legacy", LEGACY_EXCHANGE, makerV1],
    ["legacy", LEGACY_EXCHANGE, takerV1],
    ["v1", CTF_EXCHANGE_V1_ADDRESS, makerV1],
    ["v1", CTF_EXCHANGE_V1_ADDRESS, takerV1],
    ["neg", NEG_RISK_CTF_EXCHANGE_ADDRESS, makerNeg],
    ["neg", NEG_RISK_CTF_EXCHANGE_ADDRESS, takerNeg],
    ["v2", CTF_EXCHANGE_V2_ADDRESS, makerNeg],
    ["v2", CTF_EXCHANGE_V2_ADDRESS, takerNeg],
  ] as const;

  const txBySource = new Map<string, Set<string>>();
  for (const [label, address, topics] of queries) {
    const logs = await fetchAll(provider, address, topics);
    const key = `${label}:${address.slice(0, 10)}`;
    const set = txBySource.get(key) ?? new Set<string>();
    for (const l of logs) set.add(l.transactionHash.toLowerCase());
    txBySource.set(key, set);
    console.log(`${key} logs=${logs.length} uniqueTx=${set.size}`);
  }

  const currentOnly = new Set<string>();
  for (const [k, set] of txBySource) {
    if (!k.startsWith("legacy:")) for (const tx of set) currentOnly.add(tx);
  }
  const legacyOnly = txBySource.get(`legacy:${LEGACY_EXCHANGE.slice(0, 10)}`) ?? new Set();
  const allQueried = new Set([...currentOnly, ...legacyOnly]);

  const legacyExplainsApi = [...apiTx].filter(
    (tx) => legacyOnly.has(tx) && !currentOnly.has(tx)
  );
  const stillMissing = [...apiTx].filter((tx) => !allQueried.has(tx));

  console.log("\n=== TX HASH RECONCILIATION ===");
  console.log("API unique txs:", apiTx.size);
  console.log("Current 3-exchange queried txs:", currentOnly.size);
  console.log("Legacy exchange queried txs:", legacyOnly.size);
  console.log("Combined queried txs:", allQueried.size);
  console.log("API txs explained by legacy-only:", legacyExplainsApi.length);
  console.log("API txs still missing after legacy+current:", stillMissing.length);
  console.log(
    "Projected overlap if legacy added:",
    apiTx.size - stillMissing.length,
    `(${(((apiTx.size - stillMissing.length) / apiTx.size) * 100).toFixed(2)}%)`
  );

  const rpc = new PolygonRpcClient();
  const nonTradeMissing = { redeem: 0, merge: 0, split: 0, trade: 0, none: 0 };
  for (const tx of stillMissing.slice(0, 100)) {
    const receipt = await rpc.getTransactionReceipt(tx);
    let classified = "none";
    for (const log of receipt?.logs ?? []) {
      if (decodeOrderFilledV1(log) ?? decodeOrderFilledNegRisk(log)) {
        classified = "trade";
        break;
      }
    }
    const row = [...activity.rows, ...trades.rows].find(
      (r) => r.transactionHash?.toLowerCase() === tx
    );
    const t = (row?.type ?? "TRADE").toUpperCase();
    if (classified === "none") {
      if (t === "REDEEM") nonTradeMissing.redeem += 1;
      else if (t === "MERGE") nonTradeMissing.merge += 1;
      else if (t === "SPLIT") nonTradeMissing.split += 1;
      else nonTradeMissing.none += 1;
    } else nonTradeMissing.trade += 1;
  }
  console.log("\nStill-missing sample (100) classification:", nonTradeMissing);
}

void main().catch(console.error);
