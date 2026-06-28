import { eq, and } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  traderEvAnalytics,
  type TraderEvPeriod,
  type TraderEvPlatform,
} from "@/lib/crossmarket/store/schema";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";

export interface PipelineTraderEvAnalytics {
  wallet: string;
  platform: TraderEvPlatform;
  period: TraderEvPeriod;
  averageEv: number | null;
  averageEvLabel: string;
  totalPortfolioEv: number | null;
  tradeCount: number;
  closedTradeCount: number;
  updatedAt: string | null;
}

function parseNumeric(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function loadPipelineTraderEvAnalytics(
  wallet: string,
  platform: TraderEvPlatform = "polymarket",
  period: TraderEvPeriod = "live"
): Promise<PipelineTraderEvAnalytics | null> {
  if (!isDatabaseEnabled()) return null;

  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(traderEvAnalytics)
      .where(
        and(
          eq(traderEvAnalytics.wallet, wallet.toLowerCase()),
          eq(traderEvAnalytics.platform, platform),
          eq(traderEvAnalytics.period, period)
        )
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const averageEv = parseNumeric(row.averageEv);
    const totalPortfolioEv = parseNumeric(row.totalPortfolioEv);

    return {
      wallet: row.wallet,
      platform: row.platform as TraderEvPlatform,
      period: row.period as TraderEvPeriod,
      averageEv,
      averageEvLabel:
        averageEv != null ? formatEvPercent(averageEv * 100) : "—",
      totalPortfolioEv,
      tradeCount: Number(row.tradeCount) || 0,
      closedTradeCount: Number(row.closedTradeCount) || 0,
      updatedAt: row.updatedAt?.toISOString() ?? null,
    };
  } catch (err) {
    console.warn(
      "[ev/traderEvLookup] load failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
