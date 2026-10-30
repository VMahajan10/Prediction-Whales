#!/usr/bin/env tsx
/**
 * Re-index wallet 1 (full history) and compare Spain WC total bought vs Polymarket API.
 */
import "../tests/preload-env";
import { fetchClosedPositions } from "@/lib/polymarket";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import {
  persistAuthoritativePhase,
  persistDerivedPhase,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { mergeApiAndChainEvents } from "@/lib/walletLedger/onchain/normalize";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

const WALLET = "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";
const SPAIN_ASSET =
  "4394372887385518214471608448209527405727552777602031099972143344338178308080";

function sumBuyNotional(events: WalletLedgerEvent[], asset: string): number {
  return events
    .filter((e) => e.type === "BUY" && e.asset === asset)
    .reduce((s, e) => s + (e.cashUsd ?? 0), 0);
}

async function main() {
  const audit = await runIndexedWalletAudit({
    label: "spain-verify",
    wallet: WALLET,
    providerId: "etherscan_v2",
    fullHistory: true,
    allowEarlierThanIncremental: true,
    resumeCheckpoint: true,
  });

  const phase1 = await persistAuthoritativePhase(audit);
  const phase2 = await persistDerivedPhase(audit);
  console.error(
    `[spain-verify] persisted events inserted=${phase1.eventsUpserted} lifecycles=${phase2.lifecycleStats.lifecycleRowsUpserted}`
  );

  const apiEvents = audit.apiEvents ?? [];
  const chainEvents = audit.authoritativeIndexedEvents ?? [];
  const merged = mergeApiAndChainEvents(apiEvents, chainEvents);
  const apiMergedBuy = sumBuyNotional(apiEvents, SPAIN_ASSET);
  const chainBuy = sumBuyNotional(merged, SPAIN_ASSET);

  const closed = await fetchClosedPositions(WALLET, { limit: 500 });
  const apiRow = closed.find((p) => p.asset === SPAIN_ASSET);
  const apiBought = apiRow?.totalBought ?? null;

  console.log(
    JSON.stringify(
      {
        apiTotalBought: apiBought,
        chainBuyNotionalFromAudit: chainBuy,
        apiTradeEventsBuy: apiMergedBuy,
        tolerancePct: 5,
        withinTolerance:
          apiBought != null
            ? Math.abs(chainBuy - apiBought) / apiBought <= 0.05
            : null,
      },
      null,
      2
    )
  );
}

void main();
