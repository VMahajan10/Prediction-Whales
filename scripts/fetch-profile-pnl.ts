#!/usr/bin/env tsx
import "../tests/preload-env";
import { fetchPolymarketProfilePnl } from "@/lib/walletLedger/reconciliation/fetchProfilePnl";

const wallet = process.argv[2] ?? "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";

async function main() {
  const r = await fetchPolymarketProfilePnl(wallet);
  console.log(JSON.stringify(r, null, 2));
}

void main();
