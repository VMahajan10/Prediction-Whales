#!/usr/bin/env tsx
import "../tests/preload-env";
import { recoverClassDEventsForWallet } from "@/lib/walletLedger/indexed/store/classDRecovery";

const WALLETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "0x40b96182a35fbe3c2bb4162e036ecf0c786db002",
      "0x4e56f1ddaa8f5328036c449b89e731ec748cdee1",
    ];

async function main() {
  for (const wallet of WALLETS) {
    const report = await recoverClassDEventsForWallet(wallet, { apply: false });
    console.log(JSON.stringify(report, null, 2));
  }
}

void main();
