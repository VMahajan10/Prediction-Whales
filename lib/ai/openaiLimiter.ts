/**
 * Global OpenAI / Vercel AI SDK concurrency gate for pipeline + feed precomputation.
 * Prevents burst LLM calls from exhausting TPM and returning hundreds of 429s.
 */

const MAX_CONCURRENT = 2;
const MIN_GAP_MS = 450;
const MAX_ATTEMPTS = 4;

let inFlight = 0;
let waiters: Array<() => void> = [];
let lastStartedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    const gap = MIN_GAP_MS - (Date.now() - lastStartedAt);
    if (gap > 0) await sleep(gap);
    inFlight += 1;
    lastStartedAt = Date.now();
    return;
  }

  await new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
  return acquireSlot();
}

function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /rate limit|429|too many requests|tpm|tokens per min/i.test(message);
}

function retryDelayMs(attempt: number, err: unknown): number {
  const retryAfter =
    err &&
    typeof err === "object" &&
    "retryAfter" in err &&
    typeof (err as { retryAfter?: unknown }).retryAfter === "number"
      ? (err as { retryAfter: number }).retryAfter * 1000
      : null;

  if (retryAfter != null && Number.isFinite(retryAfter)) {
    return Math.min(60_000, Math.max(1_000, retryAfter));
  }

  return Math.min(30_000, 1_000 * 2 ** attempt);
}

/** Run an LLM-backed task with global concurrency + 429 backoff. */
export async function withOpenAiLimiter<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!isRateLimitError(err) || attempt === MAX_ATTEMPTS - 1) {
          throw err;
        }
        const delayMs = retryDelayMs(attempt, err);
        console.warn(
          `[openaiLimiter] rate limited; retry ${attempt + 1}/${MAX_ATTEMPTS} in ${delayMs}ms`
        );
        await sleep(delayMs);
      }
    }
    throw lastError;
  } finally {
    releaseSlot();
  }
}
