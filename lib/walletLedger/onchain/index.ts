export * from "@/lib/walletLedger/onchain/contracts";
export * from "@/lib/walletLedger/onchain/types";
export * from "@/lib/walletLedger/onchain/rpc";
export * from "@/lib/walletLedger/onchain/decode";
export * from "@/lib/walletLedger/onchain/fetcher";
export * from "@/lib/walletLedger/onchain/normalize";
export * from "@/lib/walletLedger/onchain/identity";
export * from "@/lib/walletLedger/onchain/resolution";
export * from "@/lib/walletLedger/onchain/reconcile";
export * from "@/lib/walletLedger/onchain/startBlock";
export * from "@/lib/walletLedger/onchain/pipeline";
export * from "@/lib/walletLedger/onchain/report";

/**
 * Phase 2C on-chain architecture map:
 *
 * Contracts:
 * - CTF Exchange v1 / Neg Risk / v2 → OrderFilled (BUY/SELL notional)
 * - Conditional Tokens (ERC-1155) → TransferSingle, PositionSplit, PositionsMerge,
 *   PayoutRedemption, ConditionResolution
 *
 * Flow:
 * bounded eth_getLogs + tx receipt replay
 *   → decode.ts (ABI-aligned parsers)
 *   → normalize.ts (WalletLedgerEvent source=polygon)
 *   → existing buildPositionLifecycles / computeWalletLedgerMetrics
 *   → on-chain resolution precedence over Gamma when resolutionFinal
 */
