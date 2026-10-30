#!/usr/bin/env tsx
import "../tests/preload-env";
import { syncWalletApiPositions } from "@/lib/polymarketDataApi/positionsStore";

const wallet = process.argv[2];
if (!wallet) {
  console.error("Usage: sync-wallet-api-positions.ts <wallet> [--full]");
  process.exit(1);
}

async function main() {
  const result = await syncWalletApiPositions(wallet, {
    forceFull: process.argv.includes("--full"),
  });
  console.log(result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
