import { EtherscanNoProgressTimeout } from "@/lib/walletLedger/indexed/etherscanErrors";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new EtherscanNoProgressTimeout("Rate limiter sleep aborted", undefined, "limiter_wait")
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(
        new EtherscanNoProgressTimeout("Rate limiter wait aborted", undefined, "limiter_wait")
      );
    };
    signal?.addEventListener("abort", onAbort);
  });
}

let sharedRateLimiter: EtherscanRateLimiter | null = null;

export function getSharedEtherscanRateLimiter(): EtherscanRateLimiter {
  if (!sharedRateLimiter) {
    sharedRateLimiter = new EtherscanRateLimiter();
  }
  return sharedRateLimiter;
}

export function resolveEtherscanRequestsPerSecond(): number {
  const raw = process.env.ETHERSCAN_REQUESTS_PER_SECOND?.trim();
  const parsed = raw ? Number(raw) : 2;
  if (!Number.isFinite(parsed) || parsed <= 0) return 2;
  return Math.min(parsed, 5);
}

type QueueEntry = {
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort: () => void;
};

/** Serializes Etherscan HTTP calls with pacing + bounded concurrency. */
export class EtherscanRateLimiter {
  private lastRequestAt = 0;
  activeSlots = 0;
  private readonly waitQueue: QueueEntry[] = [];
  readonly minIntervalMs: number;
  readonly requestsPerSecond: number;
  readonly maxConcurrent: number;
  pacedRequests = 0;
  waitingCount = 0;

  constructor(
    requestsPerSecond = resolveEtherscanRequestsPerSecond(),
    maxConcurrent = 1
  ) {
    this.requestsPerSecond = requestsPerSecond;
    this.minIntervalMs = Math.ceil(1000 / requestsPerSecond);
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  async throttle(signal?: AbortSignal): Promise<void> {
    const release = await this.acquire(signal);
    release();
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new EtherscanNoProgressTimeout(
        "Rate limiter acquire aborted",
        undefined,
        "limiter_wait"
      );
    }

    this.waitingCount += 1;
    try {
      if (this.activeSlots >= this.maxConcurrent) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            this.removeWaiter(entry);
            reject(
              new EtherscanNoProgressTimeout(
                "Rate limiter slot wait aborted",
                undefined,
                "limiter_wait"
              )
            );
          };
          const entry: QueueEntry = {
            resolve: () => {
              signal?.removeEventListener("abort", onAbort);
              resolve();
            },
            reject,
            onAbort,
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          this.waitQueue.push(entry);
        });
      }

      this.activeSlots += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.activeSlots = Math.max(0, this.activeSlots - 1);
        const next = this.waitQueue.shift();
        if (next) {
          next.resolve();
        }
      };

      try {
        const now = Date.now();
        const wait = this.lastRequestAt + this.minIntervalMs - now;
        if (wait > 0) {
          await sleep(wait, signal);
        }
        this.lastRequestAt = Date.now();
        this.pacedRequests += 1;
        return release;
      } catch (error) {
        release();
        throw error;
      }
    } finally {
      this.waitingCount -= 1;
    }
  }

  private removeWaiter(entry: QueueEntry): void {
    const idx = this.waitQueue.indexOf(entry);
    if (idx >= 0) this.waitQueue.splice(idx, 1);
  }
}
