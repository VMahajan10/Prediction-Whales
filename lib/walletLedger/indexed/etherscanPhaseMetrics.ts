import { auditLog } from "@/lib/walletLedger/indexed/auditProgress";
import { checkpointStoreDir } from "@/lib/walletLedger/indexed/checkpointLogStore";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type EtherscanSlowPhase =
  | "json_parse"
  | "log_normalization"
  | "range_accumulation"
  | "append_logs"
  | "flush"
  | "manifest_serialize"
  | "manifest_write"
  | "dedupe_index_append"
  | "dedupe_index_load"
  | "read_all_logs"
  | "query_dedupe"
  | "post_fetch_sync";

export interface EtherscanSlowPhaseMeta {
  inputBytes?: number;
  logCount?: number;
  checkpointKey?: string;
  page?: number;
  rangeFrom?: number;
  rangeTo?: number;
}

export interface EtherscanQueryPhaseMetrics {
  queryIndex: number;
  maxJsonParseMs: number;
  maxAppendMs: number;
  maxFlushMs: number;
  maxManifestMs: number;
  maxReadAllLogsMs: number;
  maxPostFetchSyncMs: number;
}

export interface EtherscanWalletPhaseMetricsSummary {
  wallet: string;
  queries: EtherscanQueryPhaseMetrics[];
  globalMaxPostFetchSyncMs: number;
}

const SLOW_PHASE_THRESHOLD_MS = 1_000;

let activeCollector: EtherscanPhaseMetricsCollector | null = null;
let lastWalletPhaseSummary: EtherscanWalletPhaseMetricsSummary | null = null;

export function takeLastEtherscanPhaseMetricsSummary(): EtherscanWalletPhaseMetricsSummary | null {
  const summary = lastWalletPhaseSummary;
  lastWalletPhaseSummary = null;
  return summary;
}

export function stashEtherscanPhaseMetricsSummary(
  summary: EtherscanWalletPhaseMetricsSummary
): void {
  lastWalletPhaseSummary = summary;
}

export function setActiveEtherscanPhaseMetricsCollector(
  collector: EtherscanPhaseMetricsCollector | null
): void {
  activeCollector = collector;
}

export function getActiveEtherscanPhaseMetricsCollector(): EtherscanPhaseMetricsCollector | null {
  return activeCollector;
}

function checkpointBytes(key?: string): number | undefined {
  if (!key) return undefined;
  try {
    const dir = checkpointStoreDir(key);
    if (!existsSync(dir)) return undefined;
    let total = 0;
    for (const name of readdirSync(dir)) {
      total += statSync(join(dir, name)).size;
    }
    return total;
  } catch {
    return undefined;
  }
}

export class EtherscanPhaseMetricsCollector {
  private wallet = "";
  private queryIndex = 0;
  private readonly perQuery = new Map<number, EtherscanQueryPhaseMetrics>();

  beginWallet(wallet: string): void {
    this.wallet = wallet.toLowerCase();
    this.perQuery.clear();
  }

  beginQuery(queryIndex: number): void {
    this.queryIndex = queryIndex;
    if (!this.perQuery.has(queryIndex)) {
      this.perQuery.set(queryIndex, {
        queryIndex,
        maxJsonParseMs: 0,
        maxAppendMs: 0,
        maxFlushMs: 0,
        maxManifestMs: 0,
        maxReadAllLogsMs: 0,
        maxPostFetchSyncMs: 0,
      });
    }
  }

  getQueryMetrics(queryIndex: number): EtherscanQueryPhaseMetrics | undefined {
    return this.perQuery.get(queryIndex);
  }

  summarize(): EtherscanWalletPhaseMetricsSummary {
    const queries = [...this.perQuery.values()].sort(
      (a, b) => a.queryIndex - b.queryIndex
    );
    let globalMaxPostFetchSyncMs = 0;
    for (const q of queries) {
      globalMaxPostFetchSyncMs = Math.max(
        globalMaxPostFetchSyncMs,
        q.maxPostFetchSyncMs
      );
    }
    return { wallet: this.wallet, queries, globalMaxPostFetchSyncMs };
  }

  measureSync<T>(
    phase: EtherscanSlowPhase,
    fn: () => T,
    meta: EtherscanSlowPhaseMeta = {}
  ): T {
    const started = Date.now();
    try {
      return fn();
    } finally {
      this.recordPhase(phase, Date.now() - started, meta);
    }
  }

  async measureAsync<T>(
    phase: EtherscanSlowPhase,
    fn: () => Promise<T>,
    meta: EtherscanSlowPhaseMeta = {}
  ): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.recordPhase(phase, Date.now() - started, meta);
    }
  }

  recordPhase(
    phase: EtherscanSlowPhase,
    durationMs: number,
    meta: EtherscanSlowPhaseMeta = {}
  ): void {
    const row = this.perQuery.get(this.queryIndex);
    if (row) {
      this.applyMax(row, phase, durationMs);
      row.maxPostFetchSyncMs = Math.max(row.maxPostFetchSyncMs, durationMs);
    }

    if (durationMs >= SLOW_PHASE_THRESHOLD_MS) {
      auditLog(
        [
          "[etherscan-slow-phase]",
          `wallet=${this.wallet}`,
          `query=${this.queryIndex}`,
          `phase=${phase}`,
          `durationMs=${durationMs}`,
          meta.inputBytes != null ? `inputBytes=${meta.inputBytes}` : null,
          meta.logCount != null ? `logCount=${meta.logCount}` : null,
          meta.checkpointKey
            ? `checkpointBytes=${checkpointBytes(meta.checkpointKey) ?? "unknown"}`
            : null,
        ]
          .filter(Boolean)
          .join(" ")
      );
    }
  }

  private applyMax(
    row: EtherscanQueryPhaseMetrics,
    phase: EtherscanSlowPhase,
    durationMs: number
  ): void {
    switch (phase) {
      case "json_parse":
        row.maxJsonParseMs = Math.max(row.maxJsonParseMs, durationMs);
        break;
      case "append_logs":
      case "dedupe_index_append":
        row.maxAppendMs = Math.max(row.maxAppendMs, durationMs);
        break;
      case "flush":
        row.maxFlushMs = Math.max(row.maxFlushMs, durationMs);
        break;
      case "manifest_serialize":
      case "manifest_write":
        row.maxManifestMs = Math.max(row.maxManifestMs, durationMs);
        break;
      case "read_all_logs":
        row.maxReadAllLogsMs = Math.max(row.maxReadAllLogsMs, durationMs);
        break;
      default:
        break;
    }
  }
}

export function logEtherscanQueryPhaseSummary(
  summary: EtherscanWalletPhaseMetricsSummary
): void {
  for (const q of summary.queries) {
    auditLog(
      [
        "[etherscan-query-phase-summary]",
        `wallet=${summary.wallet}`,
        `query=${q.queryIndex}`,
        `maxJsonParseMs=${q.maxJsonParseMs}`,
        `maxAppendMs=${q.maxAppendMs}`,
        `maxFlushMs=${q.maxFlushMs}`,
        `maxManifestMs=${q.maxManifestMs}`,
        `maxReadAllLogsMs=${q.maxReadAllLogsMs}`,
        `maxPostFetchSyncMs=${q.maxPostFetchSyncMs}`,
      ].join(" ")
    );
  }
}
