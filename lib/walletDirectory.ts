import "server-only";

import { eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { walletApiSyncState } from "@/lib/crossmarket/store/schema";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";
import { resolveWalletProfitFactorStats } from "@/lib/polymarketDataApi/profitFactorService";
import { getCachedTrackRecord } from "@/lib/whaleTrackStore";
import {
  DEFAULT_MIN_POSITION_COUNT,
  DIRECTORY_DEFAULT_MIN_PROFIT_FACTOR,
  formatProfitFactorValue,
  profitFactorSliceForCategoryFilter,
  type ProfitFactorCategoryFilter,
} from "@/lib/walletProfitFactor";
import { isProfitFactorStatsVerified } from "@/lib/walletLedger/ledgerDerivedStatsGate";
import { generateDeterministicWhalePseudonym } from "@/lib/whaleIdentityResolver";

export type WalletDirectorySort =
  | "highest_profit_factor"
  | "top_pnl"
  | "highest_win_rate"
  | "most_positions";

export interface WalletDirectoryQuery {
  minProfitFactor?: number;
  minPositionCount?: number;
  category?: ProfitFactorCategoryFilter;
  sort?: WalletDirectorySort;
  limit?: number;
}

export interface WalletDirectoryEntry {
  wallet: string;
  displayName: string;
  winRate: number | null;
  roi: number | null;
  totalRealizedPnl: number | null;
  positionCount: number;
  profitFactor: number | null;
  profitFactorDisplay: string;
  limitedData: boolean;
}

export async function listWalletDirectory(
  query: WalletDirectoryQuery
): Promise<WalletDirectoryEntry[]> {
  const minPf = query.minProfitFactor ?? DIRECTORY_DEFAULT_MIN_PROFIT_FACTOR;
  const minPositions = query.minPositionCount ?? DEFAULT_MIN_POSITION_COUNT;
  const category = query.category ?? "all";
  const sort = query.sort ?? "highest_profit_factor";
  const limit = Math.min(query.limit ?? 40, 60);

  if (!isPrismaEnabled() || !isDatabaseEnabled()) return [];
  const prisma = getPrisma();
  if (!prisma) return [];

  const db = getDb();
  const verifiedRows = await db
    .select({ walletAddress: walletApiSyncState.walletAddress })
    .from(walletApiSyncState)
    .where(eq(walletApiSyncState.reconciliationPassed, true));

  if (verifiedRows.length === 0) return [];

  const walletList = verifiedRows.map((r) => r.walletAddress.toLowerCase());
  const registryRows = await prisma.whaleRegistry.findMany({
    where: { walletAddress: { in: walletList } },
    select: { walletAddress: true, pseudonym: true },
  });
  const pseudonymByWallet = new Map(
    registryRows.map((r) => [r.walletAddress.toLowerCase(), r.pseudonym])
  );

  const entries: WalletDirectoryEntry[] = [];

  for (const wallet of walletList) {
    const pfStats = await resolveWalletProfitFactorStats(wallet, {
      forceSync: false,
    });
    if (!isProfitFactorStatsVerified(pfStats)) continue;

    const slice = profitFactorSliceForCategoryFilter(pfStats, category);
    if (!slice) continue;
    if (slice.positionCount < minPositions) continue;
    if (minPf > 0) {
      if (slice.profitFactor == null || slice.profitFactor < minPf) continue;
    }

    const track = await getCachedTrackRecord(wallet);

    entries.push({
      wallet,
      displayName:
        pseudonymByWallet.get(wallet)?.trim() ||
        generateDeterministicWhalePseudonym(wallet),
      winRate: slice.winRatePct,
      roi: track?.trackRecord?.roi ?? null,
      totalRealizedPnl:
        pfStats.headlineRealizedPnl ?? pfStats.netRealizedPnl ?? null,
      positionCount: slice.positionCount,
      profitFactor: slice.profitFactor,
      profitFactorDisplay:
        slice.profitFactor == null
          ? formatProfitFactorValue(null)
          : formatProfitFactorValue(slice.profitFactor),
      limitedData: slice.limitedData,
    });
  }

  entries.sort((a, b) => {
    switch (sort) {
      case "top_pnl":
        return (b.totalRealizedPnl ?? 0) - (a.totalRealizedPnl ?? 0);
      case "highest_win_rate":
        return (b.winRate ?? 0) - (a.winRate ?? 0);
      case "most_positions":
        return b.positionCount - a.positionCount;
      case "highest_profit_factor":
      default:
        return (b.profitFactor ?? 0) - (a.profitFactor ?? 0);
    }
  });

  return entries.slice(0, limit);
}
