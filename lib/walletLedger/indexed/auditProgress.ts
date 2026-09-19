import type { IndexedLogQuery } from "@/lib/walletLedger/indexed/types";
import {
  CONDITIONAL_TOKENS_ADDRESS,
  EXCHANGE_ADDRESSES,
  TOPIC_PAYOUT_REDEMPTION,
  TOPIC_POSITION_SPLIT,
  TOPIC_POSITIONS_MERGE,
} from "@/lib/walletLedger/onchain/contracts";

import type { EtherscanRateLimiter } from "@/lib/walletLedger/indexed/etherscanRateLimiter";

const HEARTBEAT_MS = 30_000;

let auditProgressForced = false;
let activeEtherscanProgress: EtherscanProgressReporter | null = null;

export function trackEtherscanProgress(reporter: EtherscanProgressReporter): void {
  activeEtherscanProgress = reporter;
}

export function stopTrackedEtherscanProgress(): void {
  activeEtherscanProgress?.stop();
  activeEtherscanProgress = null;
}

export function setAuditProgressEnabled(enabled: boolean): void {
  auditProgressForced = enabled;
}

export function isAuditProgressEnabled(): boolean {
  if (auditProgressForced) return true;
  return process.env.AUDIT_PROGRESS === "1";
}

export function auditLog(message: string): void {
  if (!isAuditProgressEnabled()) return;
  console.error(message);
}

export class AuditStageTimer {
  private readonly starts = new Map<string, number>();
  private readonly timings = new Map<string, number>();

  start(stage: string, detail?: string): void {
    this.starts.set(stage, Date.now());
    auditLog(
      `[audit-stage] start ${stage}${detail ? ` ${detail}` : ""}`
    );
  }

  end(stage: string, detail?: string): number {
    const started = this.starts.get(stage) ?? Date.now();
    const elapsedMs = Date.now() - started;
    auditLog(
      `[audit-stage] end ${stage} elapsedMs=${elapsedMs}${detail ? ` ${detail}` : ""}`
    );
    this.starts.delete(stage);
    this.timings.set(stage, elapsedMs);
    return elapsedMs;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.timings);
  }

  totalMs(): number {
    let sum = 0;
    for (const ms of this.timings.values()) sum += ms;
    return sum;
  }
}

export function describeEtherscanQueryLabel(
  query: Omit<IndexedLogQuery, "page" | "offset">
): string {
  const contract = query.address.toLowerCase();
  const topics = query.topics ?? [];
  const topic0 = typeof topics[0] === "string" ? topics[0] : null;
  const topic2 = typeof topics[2] === "string" ? topics[2] : null;
  const topic3 = typeof topics[3] === "string" ? topics[3] : null;

  let eventKind = "unknown";
  let walletRole = "unknown";
  if (
    EXCHANGE_ADDRESSES.includes(contract as (typeof EXCHANGE_ADDRESSES)[number])
  ) {
    eventKind = "OrderFilled";
    walletRole = topic2 && !topic3 ? "maker" : topic3 ? "taker" : "unknown";
  } else if (contract === CONDITIONAL_TOKENS_ADDRESS) {
    if (topic0 === TOPIC_POSITION_SPLIT) eventKind = "PositionSplit";
    else if (topic0 === TOPIC_POSITIONS_MERGE) eventKind = "PositionsMerge";
    else if (topic0 === TOPIC_PAYOUT_REDEMPTION) eventKind = "PayoutRedemption";
    walletRole = "stakeholder";
  }

  return `${contract.slice(0, 10)}…/${eventKind}/${walletRole}`;
}

export interface EtherscanProgressSnapshot {
  queryIndex: number;
  queryTotal: number;
  queryLabel: string;
  rangeFrom: number;
  rangeTo: number;
  page: number;
  requests: number;
  pages: number;
  logs: number;
  splits: number;
  rateLimitHits: number;
  lastResponseAt: number | null;
}

export class EtherscanProgressReporter {
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private snapshot: EtherscanProgressSnapshot = {
    queryIndex: 0,
    queryTotal: 0,
    queryLabel: "",
    rangeFrom: 0,
    rangeTo: 0,
    page: 0,
    requests: 0,
    pages: 0,
    logs: 0,
    splits: 0,
    rateLimitHits: 0,
    lastResponseAt: null,
  };
  private readonly startedAt = Date.now();
  private rateLimiter: EtherscanRateLimiter | null = null;
  private queryProgressClock: (() => number) | null = null;

  constructor(queryTotal = 0) {
    this.snapshot.queryTotal = queryTotal;
    if (isAuditProgressEnabled()) {
      this.heartbeat = setInterval(() => this.printHeartbeat(), HEARTBEAT_MS);
    }
  }

  bindRateLimiter(limiter: EtherscanRateLimiter): void {
    this.rateLimiter = limiter;
  }

  bindQueryProgressClock(clock: () => number): void {
    this.queryProgressClock = clock;
  }

  setQueryTotal(total: number): void {
    this.snapshot.queryTotal = total;
  }

  beginQuery(index: number, label: string, fromBlock: number, toBlock: number): void {
    this.snapshot.queryIndex = index;
    this.snapshot.queryLabel = label;
    this.snapshot.rangeFrom = fromBlock;
    this.snapshot.rangeTo = toBlock;
    auditLog(
      `[audit-stage] etherscan-query start ${index}/${this.snapshot.queryTotal} ${label} fromBlock=${fromBlock} toBlock=${toBlock}`
    );
  }

  endQuery(index: number, label: string, logs: number): void {
    auditLog(
      `[audit-stage] etherscan-query end ${index}/${this.snapshot.queryTotal} ${label} logs=${logs}`
    );
  }

  rangeStart(fromBlock: number, toBlock: number): void {
    this.snapshot.rangeFrom = fromBlock;
    this.snapshot.rangeTo = toBlock;
    auditLog(
      `[audit-stage] etherscan-range start fromBlock=${fromBlock} toBlock=${toBlock} query=${this.snapshot.queryIndex}/${this.snapshot.queryTotal}`
    );
  }

  rangeEnd(fromBlock: number, toBlock: number, logs: number, split: boolean): void {
    auditLog(
      `[audit-stage] etherscan-range end fromBlock=${fromBlock} toBlock=${toBlock} logs=${logs} split=${split}`
    );
  }

  pageFetched(page: number, logCount: number): void {
    this.snapshot.page = page;
    this.snapshot.logs += logCount;
  }

  noteResponse(): void {
    this.snapshot.lastResponseAt = Date.now();
  }

  updateCounts(input: {
    requests: number;
    pages: number;
    logs?: number;
    splits: number;
    rateLimitHits: number;
  }): void {
    this.snapshot.requests = input.requests;
    this.snapshot.pages = input.pages;
    if (input.logs != null) this.snapshot.logs = input.logs;
    this.snapshot.splits = input.splits;
    this.snapshot.rateLimitHits = input.rateLimitHits;
  }

  logTimeout(input: {
    queryLabel: string;
    fromBlock: number;
    toBlock: number;
    page: number;
    attempt: number;
    elapsedMs: number;
    hangPhase?: string;
  }): void {
    auditLog(
      `[etherscan-timeout] query=${input.queryLabel} range=${input.fromBlock}-${input.toBlock} page=${input.page} attempt=${input.attempt} elapsedMs=${input.elapsedMs} phase=${input.hangPhase ?? "unknown"}`
    );
  }

  logCheckpointLoaded(key: string, logCount: number, rangeCount: number): void {
    auditLog(
      `[audit-stage] checkpoint-load key=${key.slice(0, 80)} logs=${logCount} completedRanges=${rangeCount}`
    );
  }

  logCheckpointSaved(key: string, logCount: number, rangeCount: number): void {
    auditLog(
      `[audit-stage] checkpoint-save key=${key.slice(0, 80)} logs=${logCount} completedRanges=${rangeCount}`
    );
  }

  printHeartbeat(): void {
    const elapsed = Date.now() - this.startedAt;
    const lastAgo =
      this.snapshot.lastResponseAt == null
        ? "never"
        : `${Date.now() - this.snapshot.lastResponseAt}ms`;
    const lastProgressAgo =
      this.queryProgressClock == null
        ? "unknown"
        : `${this.queryProgressClock()}ms`;
    auditLog(
      [
        "[etherscan-progress]",
        `elapsed=${elapsed}ms`,
        `query=${this.snapshot.queryIndex}/${this.snapshot.queryTotal}`,
        `range=${this.snapshot.rangeFrom}-${this.snapshot.rangeTo}`,
        `pages=${this.snapshot.pages}`,
        `requests=${this.snapshot.requests}`,
        `logs=${this.snapshot.logs}`,
        `splits=${this.snapshot.splits}`,
        `rateLimitHits=${this.snapshot.rateLimitHits}`,
        `lastResponseAgo=${lastAgo}`,
        `lastProgressAgo=${lastProgressAgo}`,
        `limiterWaiting=${this.rateLimiter?.waitingCount ?? 0}`,
        `limiterActive=${this.rateLimiter?.activeSlots ?? 0}`,
      ].join(" ")
    );
  }

  stop(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}
