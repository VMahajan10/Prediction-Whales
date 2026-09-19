import { auditLog } from "@/lib/walletLedger/indexed/auditProgress";
import {
  EtherscanNoProgressTimeout,
  EtherscanProviderCircuitOpenError,
  EtherscanQueryMaxRuntimeError,
  EtherscanWalletMaxRuntimeError,
  resolveEtherscanNoProgressTimeoutMs,
  resolveEtherscanQueryMaxRuntimeMs,
  resolveEtherscanWalletMaxRuntimeMs,
} from "@/lib/walletLedger/indexed/etherscanErrors";

export interface EtherscanQueryProgressSnapshot {
  requests: number;
  pages: number;
  logs: number;
  completedRanges: number;
  lastPhase: string;
}

export interface EtherscanQueryControllerOptions {
  wallet: string;
  queryIndex: number;
  queryTotal: number;
  queryLabel: string;
  rangeFrom: number;
  rangeTo: number;
  noProgressTimeoutMs?: number;
  maxRuntimeMs?: number;
}

export interface EtherscanQueryRuntimeState {
  limiterActive: number;
  limiterWaiting: number;
  providerCircuitOpen: boolean;
}

export class EtherscanQueryController {
  readonly abortController = new AbortController();
  readonly signal: AbortSignal;

  private readonly startedAt = Date.now();
  private lastProgressAt = Date.now();
  private lastPhase = "query_started";
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private aborted = false;
  private pendingAbortError: Error | null = null;
  private runtimeState: EtherscanQueryRuntimeState = {
    limiterActive: 0,
    limiterWaiting: 0,
    providerCircuitOpen: false,
  };
  private snapshot: EtherscanQueryProgressSnapshot = {
    requests: 0,
    pages: 0,
    logs: 0,
    completedRanges: 0,
    lastPhase: "query_started",
  };

  constructor(private readonly options: EtherscanQueryControllerOptions) {
    this.signal = this.abortController.signal;
  }

  start(): void {
    this.markProgress("query_started");
    this.watchdogTimer = setInterval(() => {
      try {
        this.evaluateWatchdog();
      } catch (error) {
        this.abortFromWatchdog(error);
      }
    }, 5_000);
  }

  stop(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  setRuntimeState(state: EtherscanQueryRuntimeState): void {
    this.runtimeState = state;
    try {
      this.evaluateWatchdog();
    } catch (error) {
      this.abortFromWatchdog(error);
    }
  }

  getSnapshot(): EtherscanQueryProgressSnapshot {
    return { ...this.snapshot };
  }

  getLastProgressAtMs(): number {
    return this.lastProgressAt;
  }

  getLastProgressAgoMs(): number {
    return Date.now() - this.lastProgressAt;
  }

  markProgress(
    phase: string,
    input?: Partial<Omit<EtherscanQueryProgressSnapshot, "lastPhase">>
  ): void {
    const nextSnapshot = { ...this.snapshot, lastPhase: phase };
    if (input?.requests != null) nextSnapshot.requests = input.requests;
    if (input?.pages != null) nextSnapshot.pages = input.pages;
    if (input?.logs != null) nextSnapshot.logs = input.logs;
    if (input?.completedRanges != null) {
      nextSnapshot.completedRanges = input.completedRanges;
    }

    const meaningful =
      phase === "query_started" ||
      nextSnapshot.requests > this.snapshot.requests ||
      nextSnapshot.pages > this.snapshot.pages ||
      nextSnapshot.logs > this.snapshot.logs ||
      nextSnapshot.completedRanges > this.snapshot.completedRanges;

    this.snapshot = nextSnapshot;
    this.lastPhase = phase;
    if (meaningful) {
      this.lastProgressAt = Date.now();
    }
    this.throwIfAborted();
  }

  throwIfAborted(): void {
    if (this.pendingAbortError) {
      throw this.pendingAbortError;
    }
    if (this.signal.aborted) {
      throw this.abortErrorFromReason();
    }
  }

  private evaluateWatchdog(): void {
    if (this.aborted) return;
    const noProgressMs =
      this.options.noProgressTimeoutMs ?? resolveEtherscanNoProgressTimeoutMs();
    const maxRuntimeMs =
      this.options.maxRuntimeMs ?? resolveEtherscanQueryMaxRuntimeMs();
    const now = Date.now();
    const sinceProgress = now - this.lastProgressAt;
    const sinceStart = now - this.startedAt;

    if (
      this.runtimeState.providerCircuitOpen &&
      this.runtimeState.limiterActive === 0 &&
      this.runtimeState.limiterWaiting === 0
    ) {
      throw new EtherscanProviderCircuitOpenError(
        `Etherscan provider circuit open with no active work (query=${this.options.queryIndex}/${this.options.queryTotal} phase=${this.lastPhase})`,
        undefined,
        this.lastPhase
      );
    }

    if (sinceProgress > noProgressMs) {
      throw new EtherscanNoProgressTimeout(
        `Etherscan query ${this.options.queryIndex}/${this.options.queryTotal} made no progress for ${sinceProgress}ms (phase=${this.lastPhase})`,
        undefined,
        this.lastPhase
      );
    }
    if (sinceStart > maxRuntimeMs) {
      throw new EtherscanQueryMaxRuntimeError(
        `Etherscan query ${this.options.queryIndex}/${this.options.queryTotal} exceeded max runtime ${maxRuntimeMs}ms`
      );
    }
  }

  private abortFromWatchdog(error: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    const abortReason =
      error instanceof Error ? error : new Error(String(error));
    this.pendingAbortError = abortReason;
    this.abortController.abort(abortReason);
    auditLog(
      `[etherscan-watchdog] abort wallet=${this.options.wallet} query=${this.options.queryIndex}/${this.options.queryTotal} ` +
        `range=${this.options.rangeFrom}-${this.options.rangeTo} phase=${this.lastPhase} ` +
        `error=${abortReason.message}`
    );
  }

  private abortErrorFromReason(): Error {
    if (this.pendingAbortError) return this.pendingAbortError;
    const reason = this.signal.reason;
    if (reason instanceof EtherscanQueryMaxRuntimeError) return reason;
    if (reason instanceof EtherscanProviderCircuitOpenError) return reason;
    if (reason instanceof EtherscanNoProgressTimeout) return reason;
    if (reason instanceof Error) {
      if (reason.message.includes("max runtime")) {
        return new EtherscanQueryMaxRuntimeError(reason.message);
      }
      return new EtherscanNoProgressTimeout(
        reason.message,
        undefined,
        this.lastPhase
      );
    }
    return new EtherscanNoProgressTimeout(
      typeof reason === "string"
        ? reason
        : `Etherscan query aborted during phase=${this.lastPhase}`,
      undefined,
      this.lastPhase
    );
  }
}

export async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new EtherscanNoProgressTimeout(
          "Etherscan yield aborted",
          undefined,
          "yield"
        );
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new EtherscanNoProgressTimeout(
              "Etherscan yield aborted",
              undefined,
              "yield"
            )
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    setImmediate(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

export function combineAbortSignals(
  signals: Array<AbortSignal | undefined>
): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => signal != null);
  if (active.length === 0) return new AbortController().signal;
  if (active.length === 1) return active[0]!;
  const controller = new AbortController();
  const onAbort = (signal: AbortSignal) => {
    if (controller.signal.aborted) return;
    controller.abort(signal.reason);
  };
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => onAbort(signal), { once: true });
  }
  return controller.signal;
}

export class EtherscanWalletExecutionBudget {
  readonly abortController = new AbortController();
  readonly signal: AbortSignal;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly wallet: string,
    maxRuntimeMs = resolveEtherscanWalletMaxRuntimeMs()
  ) {
    this.signal = this.abortController.signal;
    this.timer = setTimeout(() => {
      if (this.signal.aborted) return;
      this.abortController.abort(
        new EtherscanWalletMaxRuntimeError(
          `Wallet ${wallet} exceeded max runtime ${maxRuntimeMs}ms`
        )
      );
    }, maxRuntimeMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
