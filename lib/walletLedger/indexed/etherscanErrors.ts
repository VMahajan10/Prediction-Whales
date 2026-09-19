export const ETHERSCAN_NO_PROGRESS_REASON = "etherscan_no_progress_timeout" as const;
export const ETHERSCAN_PROVIDER_CIRCUIT_OPEN_REASON =
  "etherscan_provider_circuit_open" as const;
export const ETHERSCAN_QUERY_MAX_RUNTIME_REASON =
  "etherscan_query_max_runtime_exceeded" as const;
export const ETHERSCAN_WALLET_MAX_RUNTIME_REASON =
  "wallet_runtime_budget_exceeded" as const;

export class EtherscanNoProgressTimeout extends Error {
  override readonly name = "EtherscanNoProgressTimeout";

  constructor(
    message: string,
    readonly reason = ETHERSCAN_NO_PROGRESS_REASON,
    readonly lastPhase?: string
  ) {
    super(message);
  }
}

export class EtherscanProviderCircuitOpenError extends Error {
  override readonly name = "EtherscanProviderCircuitOpenError";

  constructor(
    message: string,
    readonly reason = ETHERSCAN_PROVIDER_CIRCUIT_OPEN_REASON,
    readonly lastPhase?: string
  ) {
    super(message);
  }
}

export class EtherscanQueryMaxRuntimeError extends Error {
  override readonly name = "EtherscanQueryMaxRuntimeError";

  constructor(
    message: string,
    readonly reason = ETHERSCAN_QUERY_MAX_RUNTIME_REASON
  ) {
    super(message);
  }
}

export class EtherscanWalletMaxRuntimeError extends Error {
  override readonly name = "EtherscanWalletMaxRuntimeError";

  constructor(
    message: string,
    readonly reason = ETHERSCAN_WALLET_MAX_RUNTIME_REASON
  ) {
    super(message);
  }
}

export function isEtherscanNoProgressTimeout(
  error: unknown
): error is EtherscanNoProgressTimeout {
  return error instanceof EtherscanNoProgressTimeout;
}

export function isEtherscanProviderCircuitOpenError(
  error: unknown
): error is EtherscanProviderCircuitOpenError {
  return error instanceof EtherscanProviderCircuitOpenError;
}

export function isEtherscanQueryMaxRuntimeError(
  error: unknown
): error is EtherscanQueryMaxRuntimeError {
  return error instanceof EtherscanQueryMaxRuntimeError;
}

export function isEtherscanWalletMaxRuntimeError(
  error: unknown
): error is EtherscanWalletMaxRuntimeError {
  return error instanceof EtherscanWalletMaxRuntimeError;
}

export function resolveEtherscanNoProgressTimeoutMs(): number {
  const raw = process.env.ETHERSCAN_NO_PROGRESS_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : 180_000;
  if (!Number.isFinite(parsed) || parsed <= 0) return 180_000;
  return parsed;
}

export function resolveEtherscanQueryMaxRuntimeMs(): number {
  const raw = process.env.ETHERSCAN_QUERY_MAX_RUNTIME_MS?.trim();
  const parsed = raw ? Number(raw) : 1_800_000;
  if (!Number.isFinite(parsed) || parsed <= 0) return 1_800_000;
  return parsed;
}

export function resolveEtherscanWalletMaxRuntimeMs(): number {
  const raw = process.env.ETHERSCAN_WALLET_MAX_RUNTIME_MS?.trim();
  const parsed = raw ? Number(raw) : 3_600_000;
  if (!Number.isFinite(parsed) || parsed <= 0) return 3_600_000;
  return parsed;
}
