import { getEtherscanErrorMessage } from "@/lib/walletLedger/indexed/providers/etherscan";

export const ETHERSCAN_MAX_RESULTS_PER_RANGE = 10_000;
export const ETHERSCAN_MAX_PAGES_PER_RANGE = 10;

export interface AdaptiveRangeStats {
  rangesQueried: number;
  rangesSplit: number;
  pagesFetched: number;
  logsReturned: number;
}

export function isEtherscanBlockRangeError(message: string): boolean {
  return /block range|result window|window is too large|maximum.*block|query timeout|timeout when searching|range too|between blocks/i.test(
    message
  );
}

export function isEtherscanResultLimitError(message: string): boolean {
  return /result.*limit|too many results|maximum number of results|exceed.*limit/i.test(
    message
  );
}

export function shouldSplitRange(input: {
  fromBlock: number;
  toBlock: number;
  errorMessage?: string;
  pagesFetched: number;
  lastPageSize: number;
  pageSize: number;
}): boolean {
  if (input.fromBlock >= input.toBlock) return false;
  if (input.errorMessage) {
    if (
      isEtherscanBlockRangeError(input.errorMessage) ||
      isEtherscanResultLimitError(input.errorMessage)
    ) {
      return true;
    }
  }
  if (input.pagesFetched >= ETHERSCAN_MAX_PAGES_PER_RANGE) return true;
  if (
    input.pagesFetched * input.pageSize >= ETHERSCAN_MAX_RESULTS_PER_RANGE &&
    input.lastPageSize === input.pageSize
  ) {
    return true;
  }
  return false;
}

export function splitBlockRange(
  fromBlock: number,
  toBlock: number
): [{ from: number; to: number }, { from: number; to: number }] {
  const mid = Math.floor((fromBlock + toBlock) / 2);
  return [
    { from: fromBlock, to: mid },
    { from: mid + 1, to: toBlock },
  ];
}

export function rangeKey(fromBlock: number, toBlock: number): string {
  return `${fromBlock}:${toBlock}`;
}

export function formatAdaptiveSplitReason(message: string): string {
  return getEtherscanErrorMessage({
    status: "0",
    message: "NOTOK",
    result: message,
  });
}
