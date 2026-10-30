#!/usr/bin/env tsx
import "../tests/preload-env";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import { decodeLog } from "@/lib/walletLedger/onchain/decode";

const tx =
  "0xdcc112b38722de8618ea01a9f4b2e13716414571db2bfb3e319c30f73df7608b";

async function main() {
  const rpc = new PolygonRpcClient();
  const r = await rpc.getTransactionReceipt(tx);
  console.log("logs", r?.logs?.length);
  for (const log of r?.logs ?? []) {
    const p = decodeLog(log);
    console.log(log.address, log.topics[0]?.slice(0, 12), p.type);
    if (p.type === "order_filled") {
      const e = p.event;
      console.log({
        contract: e.contractAddress,
        block: e.blockNumber,
        maker: e.maker,
        taker: e.taker,
        makerAsset: e.makerAssetId,
        takerAsset: e.takerAssetId,
        makerAmt: e.makerAmountFilled.toString(),
        takerAmt: e.takerAmountFilled.toString(),
      });
    }
  }
}

void main();
