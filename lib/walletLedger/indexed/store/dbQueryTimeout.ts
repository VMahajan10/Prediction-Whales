export class DbQueryTimeoutError extends Error {
  override readonly name = "DbQueryTimeoutError";

  constructor(
    readonly label: string,
    readonly timeoutMs: number
  ) {
    super(`Database query timed out after ${timeoutMs}ms (${label})`);
  }
}

export function resolveWalletDbQueryTimeoutMs(): number {
  const raw = process.env.WALLET_DB_QUERY_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : 120_000;
  if (!Number.isFinite(parsed) || parsed <= 0) return 120_000;
  return parsed;
}

export async function withDbQueryTimeout<T>(
  label: string,
  fn: () => Promise<T>,
  timeoutMs = resolveWalletDbQueryTimeoutMs()
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new DbQueryTimeoutError(label, timeoutMs)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
