#!/usr/bin/env tsx
import "./preload-env";
import { fetchPositionsSnapshot } from "@/lib/walletLedger/fetchers";
import { discoverOnChainWalletIdentity } from "@/lib/walletLedger/onchain/identity";
import { resolvePolymarketHistoryIdentity } from "@/lib/walletLedger/identity";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";

const WALLET =
  process.argv[2] ?? "0x7e5972bfc25819775ee5a9d4f191919375487b8b";

async function main(): Promise<void> {
  const rpc = new PolygonRpcClient();
  const timings: Record<string, number> = {};

  const positionsStarted = Date.now();
  const positions = await fetchPositionsSnapshot(WALLET);
  timings.positionsFetchMs = Date.now() - positionsStarted;

  const onchainStarted = Date.now();
  const onchain = await discoverOnChainWalletIdentity({
    wallet: WALLET,
    rpc,
  });
  timings.identityOnchainMs = Date.now() - onchainStarted;

  const historyStarted = Date.now();
  const history = await resolvePolymarketHistoryIdentity({
    wallet: WALLET,
  });
  timings.identityHistoryMs = Date.now() - historyStarted;

  console.log(
    JSON.stringify(
      {
        wallet: WALLET,
        positionsCount: positions.length,
        onchainRelatedAddresses: onchain.relatedAddresses.length,
        historyWallet: history.historyWallet,
        timings,
        ok: positions.length > 0,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[probe-positions-fetch] failed:", error);
  process.exit(1);
});
