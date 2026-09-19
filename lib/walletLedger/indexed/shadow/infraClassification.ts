import { FetchTimeoutError } from "@/lib/fetchWithTimeout";
import { DbQueryTimeoutError } from "@/lib/walletLedger/indexed/store/dbQueryTimeout";
import {
  isEtherscanNoProgressTimeout,
  isEtherscanQueryMaxRuntimeError,
  isEtherscanWalletMaxRuntimeError,
  ETHERSCAN_NO_PROGRESS_REASON,
  ETHERSCAN_PROVIDER_CIRCUIT_OPEN_REASON,
  isEtherscanProviderCircuitOpenError,
} from "@/lib/walletLedger/indexed/etherscanErrors";
import { isDeterministicSqlError, isTransientNetworkError } from "@/lib/walletLedger/indexed/shadow/transientRetry";

export type ShadowExecutionOutcome =
  | "complete"
  | "unusable"
  | "wallet_failed"
  | "internal_error"
  | "deferred_infra";

export type WalletFailureKind = "infra" | "code_defect" | "wallet_data";

/** Deterministic query/result-size failure — not retryable infrastructure. */
export class QueryScaleError extends Error {
  override readonly name = "QueryScaleError";

  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function isQueryScaleError(error: unknown): boolean {
  if (error instanceof QueryScaleError) return true;
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current != null; depth += 1) {
    if (current instanceof QueryScaleError) return true;
    if (current instanceof Error) {
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}

export interface WalletFailureRecord {
  stage: string;
  message: string;
  kind: WalletFailureKind;
  timestamp: string;
}

const INFRA_PATTERNS =
  /neon|fetch failed|etimedout|econnreset|econnrefused|network|aborted|request timed out|429|5\d{2}|circuit open|provider circuit|database unavailable|db circuit|enospc|no space left on device/i;

const ENOSPC_PATTERNS = /enospc|no space left on device/i;

const CODE_DEFECT_PATTERNS =
  /is not defined|is not a function|cannot read properties of undefined|cannot read properties of null|unexpected token|assertion failed|invariant violation|programming error|maximum call stack size exceeded|rangeerror/i;

const walletFailures = new Map<string, WalletFailureRecord[]>();

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeMsg =
      cause instanceof Error ? cause.message : cause != null ? String(cause) : "";
    return `${error.message} ${causeMsg}`.trim();
  }
  return String(error);
}

export function isCodeDefectError(error: unknown): boolean {
  if (isQueryScaleError(error)) return true;
  if (error instanceof ReferenceError) return true;
  const msg = errorMessage(error).toLowerCase();
  return CODE_DEFECT_PATTERNS.test(msg);
}

export function isEnospcError(error: unknown): boolean {
  return ENOSPC_PATTERNS.test(errorMessage(error));
}

export function isEtherscanInfraTimeoutError(error: unknown): boolean {
  return (
    isEtherscanNoProgressTimeout(error) ||
    isEtherscanProviderCircuitOpenError(error) ||
    isEtherscanQueryMaxRuntimeError(error) ||
    isEtherscanWalletMaxRuntimeError(error)
  );
}

export function etherscanInfraTimeoutReason(error: unknown): string | null {
  if (isEtherscanProviderCircuitOpenError(error)) {
    return error.reason ?? ETHERSCAN_PROVIDER_CIRCUIT_OPEN_REASON;
  }
  if (isEtherscanNoProgressTimeout(error)) {
    return error.reason ?? ETHERSCAN_NO_PROGRESS_REASON;
  }
  if (isEtherscanQueryMaxRuntimeError(error)) return error.reason;
  if (isEtherscanWalletMaxRuntimeError(error)) return error.reason;
  return null;
}

export function isInfraFailureError(error: unknown): boolean {
  if (error instanceof DbQueryTimeoutError) return true;
  if (isCodeDefectError(error)) return false;
  if (isEtherscanInfraTimeoutError(error)) return true;
  if (isEnospcError(error)) return true;
  if (error instanceof FetchTimeoutError) return true;
  if (isDeterministicSqlError(error)) return false;
  if (isTransientNetworkError(error)) return true;
  return INFRA_PATTERNS.test(errorMessage(error));
}

export function isProviderInfraError(error: unknown): boolean {
  if (isCodeDefectError(error)) return false;
  if (error instanceof FetchTimeoutError) return true;
  const msg = errorMessage(error);
  return (
    /etherscan|provider circuit|rate.?limit|fetch failed|etimedout|aborted|request timed out/i.test(
      msg
    ) && isInfraFailureError(error)
  );
}

export function isDbInfraError(error: unknown): boolean {
  if (error instanceof DbQueryTimeoutError) return true;
  if (isCodeDefectError(error)) return false;
  if (isQueryScaleError(error)) return false;
  if (isDeterministicSqlError(error)) return false;
  const msg = errorMessage(error);
  if (/db circuit|database unavailable/i.test(msg)) return true;
  const walletLedgerQuery =
    /wallet_ledger|wallet_history|wallet_shadow|neon|postgres|drizzle|select count/i.test(
      msg
    );
  if (
    walletLedgerQuery &&
    /failed query/i.test(msg) &&
    !CODE_DEFECT_PATTERNS.test(msg.toLowerCase())
  ) {
    return true;
  }
  return isTransientNetworkError(error) && walletLedgerQuery;
}

export function classifyFailureKind(error: unknown): WalletFailureKind {
  if (isCodeDefectError(error)) return "code_defect";
  if (isInfraFailureError(error)) return "infra";
  return "wallet_data";
}

export function classifyExecutionOutcome(error: unknown): ShadowExecutionOutcome {
  if (isCodeDefectError(error)) return "internal_error";
  if (isDbInfraError(error)) return "deferred_infra";
  if (isInfraFailureError(error)) return "deferred_infra";
  return "wallet_failed";
}

export function recordWalletFailure(
  wallet: string,
  stage: string,
  error: unknown
): WalletFailureRecord {
  const record: WalletFailureRecord = {
    stage,
    message: errorMessage(error),
    kind: classifyFailureKind(error),
    timestamp: new Date().toISOString(),
  };
  const key = wallet.toLowerCase();
  const existing = walletFailures.get(key) ?? [];
  existing.push(record);
  walletFailures.set(key, existing);
  return record;
}

export function getWalletFailureSummary(wallet: string): {
  primaryFailure: WalletFailureRecord | null;
  secondaryFailures: WalletFailureRecord[];
} {
  const records = walletFailures.get(wallet.toLowerCase()) ?? [];
  if (records.length === 0) {
    return { primaryFailure: null, secondaryFailures: [] };
  }
  const sorted = [...records].sort((a, b) => {
    const rank = (kind: WalletFailureKind) =>
      kind === "code_defect" ? 0 : kind === "wallet_data" ? 1 : 2;
    const byKind = rank(a.kind) - rank(b.kind);
    if (byKind !== 0) return byKind;
    return a.timestamp.localeCompare(b.timestamp);
  });
  return {
    primaryFailure: sorted[0] ?? null,
    secondaryFailures: sorted.slice(1),
  };
}

export function clearWalletFailures(wallet?: string): void {
  if (wallet) {
    walletFailures.delete(wallet.toLowerCase());
    return;
  }
  walletFailures.clear();
}

export function resolveExecutionOutcome(
  wallet: string,
  terminalError?: unknown
): ShadowExecutionOutcome {
  const summary = getWalletFailureSummary(wallet);
  if (summary.primaryFailure?.kind === "code_defect") {
    return "internal_error";
  }
  if (summary.primaryFailure?.kind === "infra") {
    return "deferred_infra";
  }
  if (terminalError != null) {
    return classifyExecutionOutcome(terminalError);
  }
  if (summary.primaryFailure?.kind === "wallet_data") {
    return "wallet_failed";
  }
  return "wallet_failed";
}

export function isEnospcFailedStatus(input: {
  status: string;
  errorMessage?: string | null;
}): boolean {
  if (input.status !== "failed" && input.status !== "wallet_failed") return false;
  if (!input.errorMessage) return false;
  return isEnospcError(new Error(input.errorMessage));
}

export function isLegacyInfraFailedStatus(input: {
  status: string;
  errorMessage?: string | null;
}): boolean {
  if (input.status === "deferred_infra" || input.status === "internal_error") {
    return false;
  }
  if (input.status !== "failed" && input.status !== "wallet_failed") return false;
  if (!input.errorMessage) return input.status === "failed";
  const err = new Error(input.errorMessage);
  if (isCodeDefectError(err)) return false;
  return isInfraFailureError(err);
}
