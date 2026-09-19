#!/usr/bin/env tsx
/**
 * Stage-by-stage timing for indexed wallet audit (no full-history Etherscan).
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.json scripts/diagnose-audit-stages.ts \
 *     --wallet 0x7e59...
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  fetchActivityHistory,
  fetchPositionsSnapshot,
  fetchTradeHistory,
  probeWalletHistoryCounts,
} from "@/lib/walletLedger/fetchers";
import {
  AuditStageTimer,
  setAuditProgressEnabled,
} from "@/lib/walletLedger/indexed/auditProgress";
import { checkpointPath } from "@/lib/walletLedger/indexed/checkpoint";
import { buildEtherscanQueryPlan } from "@/lib/walletLedger/indexed/queryPlan";
import { selectBestAvailableProvider } from "@/lib/walletLedger/indexed/providers/registry";
import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";
import { discoverOnChainWalletIdentity } from "@/lib/walletLedger/onchain/identity";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import { resolvePolymarketHistoryIdentity } from "@/lib/walletLedger/identity";

function parseWallet(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--wallet" && argv[i + 1]) return argv[++i]!.toLowerCase();
  }
  throw new Error("usage: diagnose-audit-stages.ts --wallet 0x...");
}

function listCheckpoints(walletPrefix: string): string[] {
  const dir = join(process.cwd(), "tmp", "wallet-indexed-audit", "checkpoints");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) =>
    name.toLowerCase().includes(walletPrefix.slice(2, 10))
  );
}

async function main(): Promise<void> {
  const wallet = parseWallet(process.argv.slice(2));
  setAuditProgressEnabled(true);
  const stages = new AuditStageTimer();
  const rpc = new PolygonRpcClient();

  console.error(`[diagnose-audit-stages] wallet=${wallet}`);

  stages.start("provider_select");
  const providerSelection = await selectBestAvailableProvider("etherscan_v2");
  stages.end(
    "provider_select",
    `provider=${providerSelection.provider.id} reused=${providerSelection.reusedEvaluation}`
  );

  stages.start("identity_resolution_onchain");
  await discoverOnChainWalletIdentity({ wallet, rpc });
  stages.end("identity_resolution_onchain");

  stages.start("identity_resolution_history");
  const historyIdentity = await resolvePolymarketHistoryIdentity({ wallet });
  stages.end("identity_resolution_history");

  const historyWallet = historyIdentity.historyWallet ?? wallet;
  console.error(
    `[diagnose-audit-stages] historyWallet=${historyWallet} activityCount=${historyIdentity.activityCount} tradeCount=${historyIdentity.tradeCount} positionsCount=${historyIdentity.positionsCount}`
  );

  stages.start("positions_fetch_probe");
  const positions = await fetchPositionsSnapshot(historyWallet);
  stages.end("positions_fetch_probe", `rows=${positions.length}`);

  stages.start("data_api_probe");
  const probe = await probeWalletHistoryCounts(historyWallet);
  stages.end(
    "data_api_probe",
    `activity=${probe.activityCount} trades=${probe.tradeCount} positions=${probe.positionsCount}`
  );

  stages.start("data_api_history_fetch_activity");
  const activity = await fetchActivityHistory(historyWallet, {
    interPageDelayMs: 50,
    maxRows: 1_500,
  });
  stages.end(
    "data_api_history_fetch_activity",
    `rows=${activity.rows.length} pages=${activity.pagesFetched} truncated=${activity.truncated}`
  );

  stages.start("data_api_history_fetch_trades");
  const trades = await fetchTradeHistory(historyWallet, {
    interPageDelayMs: 50,
    maxRows: 1_500,
  });
  stages.end(
    "data_api_history_fetch_trades",
    `rows=${trades.rows.length} pages=${trades.pagesFetched} truncated=${trades.truncated}`
  );

  stages.start("chain_head_lookup");
  const headBlock = (await rpc.getBlockNumber()) ?? 0;
  stages.end("chain_head_lookup", `headBlock=${headBlock}`);

  stages.start("query_plan_construction");
  const plan = buildEtherscanQueryPlan(
    historyWallet,
    POLYMARKET_EXCHANGE_INITIAL_BLOCK,
    headBlock,
    [wallet, historyWallet]
  );
  stages.end("query_plan_construction", `queries=${plan.walletLogQueries}`);

  const checkpoints = listCheckpoints(wallet);
  console.error(
    `[diagnose-audit-stages] checkpoints_for_wallet=${checkpoints.length}`
  );
  for (const name of checkpoints.slice(0, 5)) {
    console.error(`  ${name} -> ${checkpointPath(name.replace(/\.json$/, ""))}`);
  }

  console.error("[diagnose-audit-stages] complete (etherscan fetch skipped)");
}

void main().catch((error) => {
  console.error("[diagnose-audit-stages] failed:", error);
  process.exit(1);
});
