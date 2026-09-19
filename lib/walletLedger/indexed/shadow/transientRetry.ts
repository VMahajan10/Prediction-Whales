import { FetchTimeoutError } from "@/lib/fetchWithTimeout";

const DETERMINISTIC_SQL =
  /syntax error|undefined column|undefined table|duplicate key value violates unique constraint|violates not-null constraint|violates foreign key constraint|invalid input syntax|relation .* does not exist|column .* does not exist|42P01|42703|23505|23502|23503|22P02/i;

export function isDeterministicSqlError(error: unknown): boolean {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) parts.push(cause.message);
    else if (typeof cause === "string") parts.push(cause);
    const code = (error as { code?: string }).code;
    if (code) parts.push(code);
  } else {
    parts.push(String(error));
  }
  return DETERMINISTIC_SQL.test(parts.join(" "));
}

export function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof FetchTimeoutError) return true;
  if (!(error instanceof Error)) {
    const msg = String(error).toLowerCase();
    return msg.includes("fetch failed") || msg.includes("etimedout");
  }
  const msg = error.message.toLowerCase();
  const cause =
    (error as Error & { cause?: unknown }).cause instanceof Error
      ? (error as Error & { cause: Error }).cause.message.toLowerCase()
      : String((error as Error & { cause?: unknown }).cause ?? "").toLowerCase();
  const combined = `${msg} ${cause}`;
  return (
    combined.includes("etimedout") ||
    combined.includes("econnreset") ||
    combined.includes("econnrefused") ||
    combined.includes("fetch failed") ||
    combined.includes("network") ||
    combined.includes("aborted") ||
    /\b429\b/.test(combined) ||
    /\b5\d{2}\b/.test(combined)
  );
}

export function isRetryableTransientError(error: unknown): boolean {
  if (isDeterministicSqlError(error)) return false;
  return isTransientNetworkError(error);
}

function jitteredBackoffMs(attempt: number, baseMs = 400): number {
  return baseMs * 2 ** attempt + Math.floor(Math.random() * 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryTransient<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; label?: string } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableTransientError(error) || attempt >= maxAttempts - 1) {
        throw error;
      }
      await sleep(jitteredBackoffMs(attempt));
    }
  }
  throw lastError;
}
