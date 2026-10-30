import "server-only";

import {
  buildWhaleTrackRecord,
  type WhaleTrackRecordResult,
} from "@/lib/polymarket";
import { resolveWalletProfitFactorStats } from "@/lib/polymarketDataApi/profitFactorService";
import type { WalletProfitFactorStats } from "@/lib/walletProfitFactor";

export type WhaleTrackRecordWithPf = WhaleTrackRecordResult & {
  profitFactorStats: WalletProfitFactorStats;
};

export async function buildWhaleTrackRecordWithPf(
  wallet: string
): Promise<WhaleTrackRecordWithPf> {
  const [result, profitFactorStats] = await Promise.all([
    buildWhaleTrackRecord(wallet),
    resolveWalletProfitFactorStats(wallet),
  ]);
  return { ...result, profitFactorStats };
}
