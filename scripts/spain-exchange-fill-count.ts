#!/usr/bin/env tsx
/**
 * Compare OrderFilled counts on legacy vs neg-risk exchange for wallet (sample blocks).
 */
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  CTF_EXCHANGE_LEGACY_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  CTF_EXCHANGE_V1_ADDRESS,
  CTF_EXCHANGE_V2_ADDRESS,
} from "@/lib/walletLedger/onchain/contracts";
import { buildWalletLogQueries } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import { selectBestAvailableProvider } from "@/lib/walletLedger/indexed/providers/registry";
import { decodeLog } from "@/lib/walletLedger/onchain/decode";
import { orderFilledToLedgerEvents } from "@/lib/walletLedger/onchain/normalize";

const w = "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";
const asset =
  "4394372887385518214471608448209527405727552777602031099972143344338178308080";

async function main() {
  const db = getDb();
  const range = await db.execute(sql`
    select min(block_number)::bigint as min_block, max(block_number)::bigint as max_block
    from wallet_ledger_events
    where lower(wallet_address)=${w} and asset_id=${asset}
  `);
  const minBlock = Number((range.rows[0] as { min_block: string }).min_block);
  const maxBlock = Number((range.rows[0] as { max_block: string }).max_block);
  const { provider } = await selectBestAvailableProvider("etherscan_v2");
  const queries = buildWalletLogQueries(w, minBlock, maxBlock);
  const byExchange: Record<string, { logs: number; spainFills: number; buyUsd: number }> =
    {};
  for (const q of queries) {
    const addr = q.address.toLowerCase();
    if (
      ![
        CTF_EXCHANGE_LEGACY_ADDRESS,
        NEG_RISK_CTF_EXCHANGE_ADDRESS,
        CTF_EXCHANGE_V1_ADDRESS,
        CTF_EXCHANGE_V2_ADDRESS,
      ].includes(addr)
    ) {
      continue;
    }
    const logs = await provider.getLogs({ ...q, page: 1, offset: 1000 });
    let spainFills = 0;
    let buyUsd = 0;
    for (const log of logs) {
      const parsed = decodeLog(log);
      if (parsed.type !== "order_filled") continue;
      const events = orderFilledToLedgerEvents(parsed.event, w, 0);
      for (const e of events) {
        if (e.asset === asset && e.type === "BUY") {
          spainFills += 1;
          buyUsd += e.cashUsd ?? 0;
        }
      }
    }
    const bucket = byExchange[addr] ?? { logs: 0, spainFills: 0, buyUsd: 0 };
    bucket.logs += logs.length;
    bucket.spainFills += spainFills;
    bucket.buyUsd += buyUsd;
    byExchange[addr] = bucket;
  }
  console.log(JSON.stringify({ minBlock, maxBlock, byExchange }, null, 2));
}

void main();
