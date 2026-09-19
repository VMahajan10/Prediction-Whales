#!/usr/bin/env tsx
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  buildQueryCheckpointKey,
  computeCheckpointResumePlan,
  readEtherscanCheckpointForIdentity,
} from "@/lib/walletLedger/indexed/checkpoint";
import { describeEtherscanQueryLabel } from "@/lib/walletLedger/indexed/auditProgress";
import { buildWalletLogQueries } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";

const wallet =
  process.argv[2] ?? "0x7e5972bfc25819775ee5a9d4f191919375487b8b";
const from = Number(process.argv[3] ?? 57_000_000);
const to = Number(process.argv[4] ?? 92_879_612);

const queries = buildWalletLogQueries(wallet, from, to);
let hits = 0;

for (let i = 0; i < queries.length; i += 1) {
  const query = queries[i]!;
  const identity = {
    providerId: "etherscan_v2",
    chainId: "137",
    wallet,
    contract: query.address.toLowerCase(),
    stableFromBlock: query.fromBlock,
    topics: query.topics ?? [],
  };
  const existing = readEtherscanCheckpointForIdentity(identity);
  const label = describeEtherscanQueryLabel(query);
  if (existing) {
    hits += 1;
    const plan = computeCheckpointResumePlan(
      query.fromBlock,
      query.toBlock,
      existing.completedRanges
    );
    console.error(
      `HIT ${i + 1}/11 ${label} logs=${existing.logs.length} reusedBlocks=${plan.reusedBlocks} newBlocks=${plan.newBlocksToFetch} key=${buildQueryCheckpointKey(identity).slice(0, 90)}`
    );
  } else {
    console.error(`MISS ${i + 1}/11 ${label}`);
  }
}

console.error(`resume_hits=${hits}/${queries.length}`);
