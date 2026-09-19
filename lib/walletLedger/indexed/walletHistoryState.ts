import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const STATE_DIR = join(process.cwd(), "tmp", "wallet-history", "wallet-state");

export interface WalletHistoryState {
  wallet: string;
  providerId: string;
  queryPlanVersion: string;
  fromBlock: number;
  lastIndexedBlock: number;
  lastReconstructedBlock: number;
  eventCount: number;
  positionCount: number;
  metricVersion: string;
  calculatedAt: string;
  historyComplete: boolean;
  historyCompletenessReasons: string[];
}

function stateKey(wallet: string, providerId: string): string {
  return createHash("sha256")
    .update(`${wallet.toLowerCase()}|${providerId}`)
    .digest("hex")
    .slice(0, 24);
}

function statePath(wallet: string, providerId: string): string {
  return join(STATE_DIR, `${stateKey(wallet, providerId)}.json`);
}

export function readWalletHistoryState(
  wallet: string,
  providerId: string
): WalletHistoryState | null {
  const path = statePath(wallet, providerId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WalletHistoryState;
  }
  catch {
    return null;
  }
}

export function writeWalletHistoryState(state: WalletHistoryState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(state.wallet, state.providerId), JSON.stringify(state, null, 2));
}

export function computeIncrementalFromBlock(
  state: WalletHistoryState | null,
  headBlock: number
): { fromBlock: number; isIncremental: boolean; gapBlocks: number } {
  if (!state || state.lastReconstructedBlock <= 0) {
    return { fromBlock: 0, isIncremental: false, gapBlocks: headBlock };
  }
  const fromBlock = state.lastReconstructedBlock + 1;
  if (fromBlock > headBlock) {
    return { fromBlock: headBlock, isIncremental: true, gapBlocks: 0 };
  }
  return {
    fromBlock,
    isIncremental: true,
    gapBlocks: headBlock - fromBlock + 1,
  };
}
