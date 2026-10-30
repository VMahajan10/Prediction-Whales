#!/usr/bin/env tsx
import "../tests/preload-env";
import { fetchTradeHistory } from "@/lib/walletLedger/fetchers";

const w = "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";
const asset =
  "4394372887385518214471608448209527405727552777602031099972143344338178308080";

async function main() {
  const { rows, truncated, pagesFetched } = await fetchTradeHistory(w, {
    interPageDelayMs: 30,
  });
  const forAsset = rows.filter(
    (r) => String(r.asset_id ?? r.asset ?? "") === asset
  );
  let buyUsd = 0;
  let sellUsd = 0;
  for (const r of forAsset) {
    const usd = Number(r.usdcSize ?? r.size ?? 0);
    if (r.side === "BUY") buyUsd += usd;
    else if (r.side === "SELL") sellUsd += usd;
  }
  console.log(
    JSON.stringify(
      {
        totalTrades: rows.length,
        truncated,
        pagesFetched,
        spainTrades: forAsset.length,
        spainBuyUsd: buyUsd,
        spainSellUsd: sellUsd,
      },
      null,
      2
    )
  );
}

void main();
