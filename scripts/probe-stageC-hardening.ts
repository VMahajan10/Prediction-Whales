#!/usr/bin/env tsx
/**
 * Stage C hardening probe — isolated wallet etherscan fetch with metrics.
 *
 * Usage:
 *   AUDIT_PROGRESS=1 npx tsx --tsconfig tsconfig.json scripts/probe-stageC-hardening.ts --wallet 0x...
 *
 * Does NOT resume Stage C batch.
 */
import "./preload-env";

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EtherscanProgressReporter,
  setAuditProgressEnabled,
} from "@/lib/walletLedger/indexed/auditProgress";
import {
  CHECKPOINT_STORE_DIR,
} from "@/lib/walletLedger/indexed/checkpointLogStore";
import {
  logEtherscanQueryPhaseSummary,
  takeLastEtherscanPhaseMetricsSummary,
} from "@/lib/walletLedger/indexed/etherscanPhaseMetrics";
import {
  EventLoopDelayMonitor,
} from "@/lib/walletLedger/indexed/eventLoopMonitor";
import { fetchIndexedWalletHistory } from "@/lib/walletLedger/indexed/walletHistory";
import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import { getSharedEtherscanRateLimiter } from "@/lib/walletLedger/indexed/etherscanRateLimiter";
import {
  classifyExecutionOutcome,
  etherscanInfraTimeoutReason,
} from "@/lib/walletLedger/indexed/shadow/infraClassification";
import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import {
  getActiveEtherscanPhaseMetricsCollector,
} from "@/lib/walletLedger/indexed/etherscanPhaseMetrics";

function parseWallet(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--wallet" && argv[i + 1]) {
      return argv[++i]!.toLowerCase();
    }
  }
  throw new Error("Usage: probe-stageC-hardening.ts --wallet 0x...");
}

function walletCheckpointBytes(wallet: string): number {
  if (!existsSync(CHECKPOINT_STORE_DIR)) return 0;
  const tag = wallet.slice(2, 10);
  let total = 0;
  for (const name of readdirSync(CHECKPOINT_STORE_DIR)) {
    if (!name.includes(tag)) continue;
    const dir = join(CHECKPOINT_STORE_DIR, name);
    for (const file of readdirSync(dir)) {
      total += statSync(join(dir, file)).size;
    }
  }
  return total;
}

function dirSizeBefore(cwd: string): number {
  const dir = join(cwd, "tmp", "wallet-history", "checkpoints");
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    const sub = join(dir, name);
    for (const file of readdirSync(sub)) {
      total += statSync(join(sub, file)).size;
    }
  }
  return total;
}

async function main(): Promise<void> {
  const wallet = parseWallet(process.argv.slice(2));
  setAuditProgressEnabled(true);
  const limiter = getSharedEtherscanRateLimiter();
  const provider = new EtherscanV2LogProvider();
  const reporter = new EtherscanProgressReporter();
  const rpc = new PolygonRpcClient();
  const eventLoopMonitor = new EventLoopDelayMonitor();
  eventLoopMonitor.start();

  const checkpointBeforeBytes = walletCheckpointBytes(wallet);
  const diskBeforeBytes = dirSizeBefore(process.cwd());
  const startedAt = Date.now();

  const latestBlock = (await rpc.getBlockNumber()) ?? 78_000_000;
  const fromBlock = POLYMARKET_EXCHANGE_INITIAL_BLOCK;
  const toBlock = latestBlock;

  const heartbeat = setInterval(() => {
    const snap = eventLoopMonitor.snapshot();
    console.error(
      `[probe-hardening] wallet=${wallet} elapsedSec=${Math.round((Date.now() - startedAt) / 1000)} ` +
        `limiterWaiting=${limiter.waitingCount} limiterActive=${limiter.activeSlots} ` +
        `eventLoopDelayP95Ms=${snap.eventLoopDelayP95Ms} eventLoopDelayMaxMs=${snap.eventLoopDelayMaxMs}`
    );
  }, 30_000);

  console.error(
    `[probe-hardening] start wallet=${wallet} checkpointSizeMB=${(checkpointBeforeBytes / 1_048_576).toFixed(1)} fromBlock=${fromBlock} toBlock=${toBlock}`
  );

  let resultLabel: "complete" | "deferred_infra" | "unusable" | "failed" = "failed";

  let logsReturned = 0;

  try {
    const result = await fetchIndexedWalletHistory({
      provider,
      wallet,
      fromBlock,
      toBlock,
      resumeCheckpoint: true,
      etherscanProgress: reporter,
    });
    resultLabel = "complete";
    logsReturned = result.stats.logsReturned;
    console.error(
      `[probe-hardening] complete wallet=${wallet} queries=${result.queriesExecuted} requests=${result.stats.requests} pages=${result.stats.pages} logs=${result.stats.logsReturned} elapsedSec=${Math.round((Date.now() - startedAt) / 1000)}`
    );
  } catch (error) {
    const outcome = classifyExecutionOutcome(error);
    const reason = etherscanInfraTimeoutReason(error);
    resultLabel = outcome === "deferred_infra" ? "deferred_infra" : outcome === "unusable" ? "unusable" : "failed";
    console.error(
      `[probe-hardening] terminated wallet=${wallet} outcome=${outcome} reason=${reason ?? "n/a"} message=${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    clearInterval(heartbeat);
    reporter.stop();
    const eventLoop = eventLoopMonitor.snapshot();
    eventLoopMonitor.stop();
    const checkpointAfterBytes = walletCheckpointBytes(wallet);
    const diskAfterBytes = dirSizeBefore(process.cwd());
    const phaseSummary = takeLastEtherscanPhaseMetricsSummary();
    if (phaseSummary) logEtherscanQueryPhaseSummary(phaseSummary);
    const aggregate = phaseSummary?.queries.reduce(
      (acc, q) => ({
        maxJsonParseMs: Math.max(acc.maxJsonParseMs, q.maxJsonParseMs),
        maxAppendMs: Math.max(acc.maxAppendMs, q.maxAppendMs),
        maxFlushMs: Math.max(acc.maxFlushMs, q.maxFlushMs),
        maxReadAllLogsMs: Math.max(acc.maxReadAllLogsMs, q.maxReadAllLogsMs),
        maxPostFetchSyncMs: Math.max(acc.maxPostFetchSyncMs, q.maxPostFetchSyncMs),
      }),
      {
        maxJsonParseMs: 0,
        maxAppendMs: 0,
        maxFlushMs: 0,
        maxReadAllLogsMs: 0,
        maxPostFetchSyncMs: 0,
      }
    );

    console.error(
      JSON.stringify(
        {
          wallet,
          checkpointSizeMB: Number((checkpointAfterBytes / 1_048_576).toFixed(2)),
          checkpointDeltaMB: Number(
            ((checkpointAfterBytes - checkpointBeforeBytes) / 1_048_576).toFixed(2)
          ),
          queries: phaseSummary?.queries.length ?? 0,
          requests: provider.requests,
          pages: provider.pagesFetched,
          logs: logsReturned,
          elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          maxJsonParseMs: aggregate?.maxJsonParseMs ?? 0,
          maxAppendMs: aggregate?.maxAppendMs ?? 0,
          maxFlushMs: aggregate?.maxFlushMs ?? 0,
          maxReadAllLogsMs: aggregate?.maxReadAllLogsMs ?? 0,
          maxPostFetchSyncMs: phaseSummary?.globalMaxPostFetchSyncMs ?? 0,
          eventLoopDelayP95Ms: eventLoop.eventLoopDelayP95Ms,
          eventLoopDelayMaxMs: eventLoop.eventLoopDelayMaxMs,
          limiterWaitingAtExit: limiter.waitingCount,
          limiterActiveAtExit: limiter.activeSlots,
          diskDeltaMB: Number(((diskAfterBytes - diskBeforeBytes) / 1_048_576).toFixed(2)),
          result: resultLabel,
        },
        null,
        2
      )
    );
  }
}

main().catch((error) => {
  console.error("[probe-hardening] fatal", error);
  process.exit(1);
});
