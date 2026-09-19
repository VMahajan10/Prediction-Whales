#!/usr/bin/env tsx
/**
 * Isolated bounded-execution probe for stuck wallet 0x821dab…
 *
 * Usage:
 *   AUDIT_PROGRESS=1 npx tsx --tsconfig tsconfig.json scripts/probe-821dab-etherscan-bounded.ts
 *
 * Does NOT resume Stage C batch.
 */
import "./preload-env";

import {
  EtherscanProgressReporter,
  setAuditProgressEnabled,
} from "@/lib/walletLedger/indexed/auditProgress";
import { fetchIndexedWalletHistory } from "@/lib/walletLedger/indexed/walletHistory";
import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import { getSharedEtherscanRateLimiter } from "@/lib/walletLedger/indexed/etherscanRateLimiter";
import {
  classifyExecutionOutcome,
  etherscanInfraTimeoutReason,
} from "@/lib/walletLedger/indexed/shadow/infraClassification";
import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";

const WALLET = "0x821dab0565ebf5b327f51db06223fdcfe01acf16";

async function main(): Promise<void> {
  setAuditProgressEnabled(true);
  const limiter = getSharedEtherscanRateLimiter();
  const provider = new EtherscanV2LogProvider();
  const reporter = new EtherscanProgressReporter();
  const rpc = new PolygonRpcClient();
  const startedAt = Date.now();

  const latestBlock = (await rpc.getBlockNumber()) ?? 78_000_000;
  const fromBlock = POLYMARKET_EXCHANGE_INITIAL_BLOCK;
  const toBlock = latestBlock;

  const heartbeat = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    console.error(
      `[probe-821dab] elapsedSec=${elapsedSec} limiterWaiting=${limiter.waitingCount} limiterActive=${limiter.activeSlots} providerRequests=${provider.requests} providerPages=${provider.pagesFetched}`
    );
  }, 30_000);

  console.error(
    `[probe-821dab] starting isolated etherscan fetch wallet=${WALLET} fromBlock=${fromBlock} toBlock=${toBlock} resumeCheckpoint=true`
  );

  try {
    const result = await fetchIndexedWalletHistory({
      provider,
      wallet: WALLET,
      fromBlock,
      toBlock,
      resumeCheckpoint: true,
      etherscanProgress: reporter,
    });
    console.error(
      `[probe-821dab] complete queries=${result.queriesExecuted} requests=${result.stats.requests} pages=${result.stats.pages} logs=${result.stats.logsReturned} elapsedMs=${result.stats.elapsedMs}`
    );
  } catch (error) {
    const outcome = classifyExecutionOutcome(error);
    const reason = etherscanInfraTimeoutReason(error);
    console.error(
      `[probe-821dab] terminated outcome=${outcome} reason=${reason ?? "n/a"} message=${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (outcome !== "deferred_infra") {
      process.exitCode = 1;
    }
  } finally {
    clearInterval(heartbeat);
    console.error(
      `[probe-821dab] done elapsedSec=${Math.round((Date.now() - startedAt) / 1000)} limiterWaiting=${limiter.waitingCount} limiterActive=${limiter.activeSlots}`
    );
    reporter.stop();
  }
}

main().catch((error) => {
  console.error("[probe-821dab] fatal", error);
  process.exit(1);
});
