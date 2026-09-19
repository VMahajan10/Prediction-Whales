import { EtherscanWalletMaxRuntimeError } from "@/lib/walletLedger/indexed/etherscanErrors";

export function assertPersistenceNotAborted(
  abortSignal?: AbortSignal,
  phase = "persistence"
): void {
  if (!abortSignal?.aborted) return;
  const reason = abortSignal.reason;
  if (reason instanceof EtherscanWalletMaxRuntimeError) throw reason;
  if (reason instanceof Error) {
    throw new EtherscanWalletMaxRuntimeError(
      `Wallet persistence aborted during ${phase}: ${reason.message}`
    );
  }
  throw new EtherscanWalletMaxRuntimeError(
    `Wallet persistence aborted during ${phase}`
  );
}
