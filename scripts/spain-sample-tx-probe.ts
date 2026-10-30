#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import { decodeLog } from "@/lib/walletLedger/onchain/decode";
import { orderFilledToLedgerEvents } from "@/lib/walletLedger/onchain/normalize";

const w = "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";
const asset =
  "4394372887385518214471608448209527405727552777602031099972143344338178308080";

async function main() {
  const db = getDb();
  const txs = await db.execute(sql`
    select tx_hash, event_type, cash_usd, shares, block_number
    from wallet_ledger_events
    where lower(wallet_address)=${w} and asset_id=${asset} and event_type='BUY'
    order by cash_usd desc nulls last
    limit 3
  `);
  const rpc = new PolygonRpcClient();
  for (const row of txs.rows as {
    tx_hash: string;
    cash_usd: number;
    block_number: number;
  }[]) {
    const receipt = await rpc.getTransactionReceipt(row.tx_hash);
    const fills = (receipt?.logs ?? [])
      .map((log) => decodeLog(log))
      .filter((p) => p.type === "order_filled");
    console.log(
      JSON.stringify(
        {
          tx: row.tx_hash,
          dbCash: row.cash_usd,
          fills: fills.map((f) =>
            f.type === "order_filled"
              ? {
                  contract: f.event.contractAddress,
                  maker: f.event.maker,
                  taker: f.event.taker,
                  makerAsset: f.event.makerAssetId,
                  takerAsset: f.event.takerAssetId,
                  makerAmt: f.event.makerAmountFilled.toString(),
                  takerAmt: f.event.takerAmountFilled.toString(),
                  ledgerForProxy: orderFilledToLedgerEvents(
                    f.event,
                    w,
                    0
                  ).map((e) => ({
                    type: e.type,
                    cash: e.cashUsd,
                    shares: e.shares,
                  })),
                }
              : null
          ),
        },
        null,
        2
      )
    );
  }
}

void main();
