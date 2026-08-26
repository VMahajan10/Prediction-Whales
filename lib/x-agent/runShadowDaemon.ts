import { randomUUID } from "node:crypto";
import {
  PolymarketLiveSocket,
  type SocketTrade,
} from "@/lib/polymarketLiveSocket";
import { runEvPipeline } from "@/lib/evPipeline/pipeline";
import {
  runWithPipelineLock,
  writePipelineMeta,
} from "@/lib/evPipeline/redisCache";
import { resolveWalletForTrade } from "@/lib/resolveWhaleWallet";
import {
  MIN_RAW_INGESTION_STAKE_USD,
  meetsFeedTradeEvThreshold,
} from "@/lib/feedQualification";
import { recordFeedTradeHistory } from "@/lib/feed/feedTradeHistory";
import { qualifyWalletForFeed } from "@/lib/feedQualificationServer";
import { passesPolymarketFeedTraderGate } from "@/lib/feedQualification";
import { coalesceDisplayEvPercent } from "@/lib/evPipeline/tradeEvRecord";
import { ensureFullyComputedTradeEv } from "@/lib/evPipeline/resolveTradeEv";
import { pipelineEvLookupKey } from "@/lib/evPipeline/types";
import { tradeToWhale } from "@/lib/whaleTrades";
import { processWhaleTradeForXAgent } from "@/lib/x-agent/enqueueWhaleTrade";
import {
  setShadowWorkerWebSocketConnected,
  writeShadowWorkerHeartbeat,
} from "@/lib/x-agent/shadowWorkerHeartbeat";
import { ensureWalletCredibilityHydrated } from "@/lib/x-agent/walletCredibility";
import { flushAllBatchedNeonWrites } from "@/lib/x-agent/batchedNeonWrites";
import {
  passesShadowProductFeedGate,
  socketTradeToEvInput,
} from "@/lib/x-agent/shadowTradeQualification";
import {
  printGateSummaryBox,
  RollingGateMatrixTracker,
  type GateSummary,
} from "@/lib/x-agent/gateMetrics";
import { EV_PIPELINE_LOCK_HELD_MESSAGE } from "@/lib/x-agent/runShadowPipeline";

export interface ShadowDaemonOptions {
  rollingWindowSize?: number;
  summaryEveryTrades?: number;
  summaryEveryMs?: number;
  minUsdNotional?: number;
}

export interface ShadowDaemonStats {
  tradesObserved: number;
  tradesEvaluated: number;
  tradesProcessed: number;
  tradesFailed: number;
  evPipelineOk: boolean;
}

const DEFAULT_ROLLING_WINDOW = 1000;
const DEFAULT_SUMMARY_EVERY_TRADES = 100;
const DEFAULT_SUMMARY_EVERY_MS = 60 * 60 * 1000;
const SOCKET_START_RETRY_BASE_MS = 1_000;
const SOCKET_START_RETRY_MAX_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Worker path: hydrate wallet credibility before feed persistence and X-agent gates. */
export async function runShadowWorkerTradePipeline(
  trade: SocketTrade,
  handlers: {
    persistFeedTrade: (
      trade: SocketTrade,
      whale: Awaited<ReturnType<typeof socketTradeToWhale>>
    ) => Promise<void>;
    processXAgent: (
      whale: Awaited<ReturnType<typeof socketTradeToWhale>>,
      hydrationResolution: Awaited<
        ReturnType<typeof ensureWalletCredibilityHydrated>
      > | null
    ) => Promise<void>;
  }
): Promise<void> {
  const whale = await socketTradeToWhale(trade);
  const hydrationResolution = whale.proxyWallet?.trim()
    ? await ensureWalletCredibilityHydrated(whale.proxyWallet, {
        tradeId: trade.id,
      })
    : null;
  await handlers.persistFeedTrade(trade, whale);
  await handlers.processXAgent(whale, hydrationResolution);
}

export async function socketTradeToWhale(trade: SocketTrade) {
  let proxyWallet: string | undefined;
  if (trade.transactionHash) {
    const resolved = await resolveWalletForTrade(trade.transactionHash, {
      assetId: trade.assetId,
    });
    proxyWallet = resolved.wallet ?? undefined;
  }

  return tradeToWhale(
    {
      id: trade.id,
      title: trade.title,
      side: trade.side,
      outcome: trade.outcome,
      price: trade.price,
      size: trade.size,
      timestamp: trade.timestamp,
      transactionHash: trade.transactionHash,
      assetId: trade.assetId,
      eventSlug: trade.eventSlug,
      slug: trade.slug,
      conditionId: trade.conditionId,
      proxyWallet,
    },
    {
      detectedAt: Date.now(),
      isLive: true,
      usdNotional: trade.usdNotional,
      source: "polymarket",
    }
  );
}

export function parseShadowDaemonOptionsFromEnv(): ShadowDaemonOptions {
  const rollingWindowSize = Number(process.env.SHADOW_DAEMON_ROLLING_WINDOW);
  const summaryEveryTrades = Number(process.env.SHADOW_DAEMON_SUMMARY_TRADES);
  const summaryEverySec = Number(process.env.SHADOW_DAEMON_SUMMARY_SEC);
  const minUsd = Number(process.env.SHADOW_DAEMON_MIN_USD);

  return {
    rollingWindowSize:
      Number.isFinite(rollingWindowSize) && rollingWindowSize > 0
        ? rollingWindowSize
        : DEFAULT_ROLLING_WINDOW,
    summaryEveryTrades:
      Number.isFinite(summaryEveryTrades) && summaryEveryTrades > 0
        ? summaryEveryTrades
        : DEFAULT_SUMMARY_EVERY_TRADES,
    summaryEveryMs:
      Number.isFinite(summaryEverySec) && summaryEverySec > 0
        ? summaryEverySec * 1000
        : DEFAULT_SUMMARY_EVERY_MS,
    minUsdNotional:
      Number.isFinite(minUsd) && minUsd >= 0
        ? minUsd
        : MIN_RAW_INGESTION_STAKE_USD,
  };
}

/**
 * 24/7 Polymarket WebSocket daemon: evaluate live trades through the gate matrix,
 * enqueue passing trades, and emit rolling diagnostics.
 */
export class ShadowCronDaemon {
  private readonly rolling: RollingGateMatrixTracker;
  private readonly summaryEveryTrades: number;
  private readonly summaryEveryMs: number;
  private socket: PolymarketLiveSocket | null = null;
  private stopping = false;
  private draining = false;
  private readonly pending: SocketTrade[] = [];
  private lastSummaryAt = Date.now();
  private evaluationsSinceSummary = 0;
  private evPipelineOk = false;
  private evError?: string;

  readonly stats: ShadowDaemonStats = {
    tradesObserved: 0,
    tradesEvaluated: 0,
    tradesProcessed: 0,
    tradesFailed: 0,
    evPipelineOk: false,
  };

  constructor(private readonly options: ShadowDaemonOptions = {}) {
    this.rolling = new RollingGateMatrixTracker(
      options.rollingWindowSize ?? DEFAULT_ROLLING_WINDOW
    );
    this.summaryEveryTrades =
      options.summaryEveryTrades ?? DEFAULT_SUMMARY_EVERY_TRADES;
    this.summaryEveryMs = options.summaryEveryMs ?? DEFAULT_SUMMARY_EVERY_MS;
  }

  getRollingSummary(): GateSummary {
    return this.rolling.aggregate();
  }

  getRollingWindowSize(): number {
    return this.rolling.getWindowSize();
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  async warmEvPipeline(): Promise<void> {
    const runId = randomUUID();
    const lockResult = await runWithPipelineLock(runId, async () => {
      try {
        const result = await runEvPipeline(runId);
        await writePipelineMeta({
          runId,
          finishedAt: new Date().toISOString(),
          stages: result.stages,
        });

        const ok = Object.values(result.stages).every((stage) => stage.ok);
        const error = ok
          ? undefined
          : Object.values(result.stages)
              .filter((stage) => !stage.ok && stage.error)
              .map((stage) => stage.error)
              .join("; ");

        return { evPipelineOk: ok, evError: error };
      } catch (err) {
        return {
          evPipelineOk: false,
          evError: err instanceof Error ? err.message : String(err),
        };
      }
    });

    if (!lockResult.acquired) {
      this.evPipelineOk = false;
      this.evError = EV_PIPELINE_LOCK_HELD_MESSAGE;
      this.stats.evPipelineOk = false;
      return;
    }

    this.evPipelineOk = lockResult.value.evPipelineOk;
    this.evError = lockResult.value.evError;
    this.stats.evPipelineOk = this.evPipelineOk;
  }

  async start(): Promise<void> {
    if (this.socket) return;

    this.stopping = false;
    const socket = new PolymarketLiveSocket({
      minUsdNotional:
        this.options.minUsdNotional ?? MIN_RAW_INGESTION_STAKE_USD,
      onTrade: async (trade) => {
        if (this.stopping) return;
        this.stats.tradesObserved += 1;
        this.pending.push(trade);
        void this.drainQueue();
      },
    });
    this.socket = socket;

    // An empty token registry (transient Polymarket outage or rate limit) makes
    // start() throw. Letting that escape exits the process, and the host restarts
    // straight back into it — so retry in place instead. start() throws before
    // it ever opens a socket, so retrying cannot double-connect.
    for (let attempt = 1; !this.stopping; attempt += 1) {
      try {
        await socket.start();
        console.log(
          "[Shadow Daemon] Polymarket WebSocket connected — listening for live trades"
        );
        setShadowWorkerWebSocketConnected(true);
        void writeShadowWorkerHeartbeat();
        return;
      } catch (err) {
        const delay = Math.min(
          SOCKET_START_RETRY_BASE_MS * 2 ** (attempt - 1),
          SOCKET_START_RETRY_MAX_MS
        );
        console.warn(
          `[Shadow Daemon] WebSocket start failed (attempt ${attempt}) — retrying in ${Math.round(delay / 1000)}s:`,
          err instanceof Error ? err.message : err
        );
        await sleep(delay);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    setShadowWorkerWebSocketConnected(false);
    this.socket?.stop();
    this.socket = null;

    while (this.draining || this.pending.length > 0) {
      await sleep(100);
    }

    await flushAllBatchedNeonWrites();
  }

  maybePrintRollingSummary(force = false): void {
    const dueByTrades = this.evaluationsSinceSummary >= this.summaryEveryTrades;
    const dueByTime = Date.now() - this.lastSummaryAt >= this.summaryEveryMs;
    if (!force && !dueByTrades && !dueByTime) return;

    printGateSummaryBox(this.getRollingSummary(), {
      rollingWindow: this.getRollingWindowSize(),
    });
    this.lastSummaryAt = Date.now();
    this.evaluationsSinceSummary = 0;
  }

  startSummaryTicker(): NodeJS.Timeout {
    return setInterval(() => {
      this.maybePrintRollingSummary();
    }, 60_000);
  }

  private async drainQueue(): Promise<void> {
    if (this.draining || this.stopping) return;
    this.draining = true;

    while (this.pending.length > 0 && !this.stopping) {
      const trade = this.pending.shift();
      if (!trade) break;

      try {
        if (!(await passesShadowProductFeedGate(trade))) continue;

        await runShadowWorkerTradePipeline(trade, {
          persistFeedTrade: (socketTrade, hydratedWhale) =>
            this.persistFeedTrade(socketTrade, hydratedWhale),
          processXAgent: (hydratedWhale, hydrationResolution) =>
            processWhaleTradeForXAgent(hydratedWhale, this.rolling, {
              preHydratedResolution: hydrationResolution ?? undefined,
            }),
        });
        this.stats.tradesProcessed += 1;
      } catch (err) {
        this.stats.tradesFailed += 1;
        console.warn(
          "[Shadow Daemon] trade processing failed",
          trade.id,
          err instanceof Error ? err.message : err
        );
      } finally {
        this.rolling.finalizeTrade();
        this.stats.tradesEvaluated += 1;
        this.evaluationsSinceSummary += 1;
        this.maybePrintRollingSummary();
      }
    }

    this.draining = false;
    if (this.pending.length > 0 && !this.stopping) {
      void this.drainQueue();
    }
  }

  /** Live socket trades must reach feed_trades — /api/feed alone is browser-gated. */
  private async persistFeedTrade(
    trade: SocketTrade,
    whale: Awaited<ReturnType<typeof socketTradeToWhale>>
  ): Promise<void> {
    const evInput = socketTradeToEvInput(trade);
    const lookupKey = evInput ? pipelineEvLookupKey(evInput) : null;
    if (!evInput || !lookupKey) return;

    const pipeline = await ensureFullyComputedTradeEv(
      lookupKey,
      evInput,
      null,
      { cacheOnly: true }
    );
    const evPercent = coalesceDisplayEvPercent(pipeline);
    if (!meetsFeedTradeEvThreshold(evPercent)) return;

    const wallet = whale.proxyWallet?.trim();
    const traderQualification = wallet
      ? await qualifyWalletForFeed(wallet)
      : null;
    if (
      wallet &&
      !passesPolymarketFeedTraderGate(wallet, traderQualification)
    ) {
      return;
    }

    await recordFeedTradeHistory([
      {
        id: trade.id,
        transactionHash: trade.transactionHash,
        proxyWallet: whale.proxyWallet,
        title: trade.title,
        timestamp: trade.timestamp,
        stakeAmountUsd: trade.usdNotional,
        averageEvPercent: evPercent!,
        payload: {
          id: trade.id,
          title: trade.title,
          outcome: trade.outcome,
          side: trade.side,
          price: trade.price,
          size: trade.size,
          timestamp: trade.timestamp,
          transactionHash: trade.transactionHash,
          slug: trade.slug,
          assetId: trade.assetId,
          proxyWallet: whale.proxyWallet,
        },
      },
    ]);
  }
}

export async function runShadowCronDaemon(
  options: ShadowDaemonOptions = {}
): Promise<ShadowCronDaemon> {
  const daemon = new ShadowCronDaemon(options);
  await daemon.warmEvPipeline();
  if (daemon.stats.evPipelineOk) {
    console.log("[Shadow Daemon] EV pipeline warm-up complete");
  } else {
    console.warn(
      "[Shadow Daemon] EV pipeline warm-up incomplete",
      daemon.stats.evPipelineOk ? "" : "(continuing with live feed)"
    );
  }
  await daemon.start();
  return daemon;
}
