import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { whaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  MIN_WALLET_AVG_EV_DECIMAL,
  MIN_WALLET_RESOLVED_BETS,
} from "@/lib/x-agent/gateMetrics";
import { walletMeetsCredibilityCriteria } from "@/lib/x-agent/walletCredibility";

export interface ProductionCredibilitySnapshot {
  wallet: string;
  inRegistry: boolean;
  productionCredible: boolean | null;
  resolvedBetsCount: number | null;
  avgEv: number | null;
  winRate: number | null;
  avgStakeNotional: number | null;
  hydrationStatus: string | null;
  hydratedAt: string | null;
  productionGateReason: string;
}

export async function loadProductionCredibilitySnapshot(
  wallet: string
): Promise<ProductionCredibilitySnapshot> {
  const db = getDb();
  const normalized = wallet.toLowerCase();
  const rows = await db
    .select()
    .from(whaleRegistry)
    .where(sql`lower(${whaleRegistry.walletAddress}) = ${normalized}`)
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      wallet: normalized,
      inRegistry: false,
      productionCredible: null,
      resolvedBetsCount: null,
      avgEv: null,
      winRate: null,
      avgStakeNotional: null,
      hydrationStatus: null,
      hydratedAt: null,
      productionGateReason: "not_in_registry",
    };
  }

  const stats = {
    resolvedBetsCount: row.resolvedBetsCount,
    avgEv: row.avgEv,
    winRate: row.winRate,
    closedCount: row.resolvedBetsCount,
  };
  const credible =
    row.hydrationStatus === "complete"
      ? walletMeetsCredibilityCriteria(stats)
      : null;
  let reason = "ok";
  if (row.hydrationStatus !== "complete") {
    reason = `hydration_${row.hydrationStatus}`;
  } else if (!walletMeetsCredibilityCriteria(stats)) {
    if (row.resolvedBetsCount < MIN_WALLET_RESOLVED_BETS) {
      reason = "below_resolved_bets";
    } else if (row.avgEv < MIN_WALLET_AVG_EV_DECIMAL) {
      reason = "below_avg_ev";
    } else {
      reason = "below_credibility_threshold";
    }
  }

  return {
    wallet: normalized,
    inRegistry: true,
    productionCredible: credible,
    resolvedBetsCount: row.resolvedBetsCount,
    avgEv: row.avgEv,
    winRate: row.winRate,
    avgStakeNotional: row.avgStakeNotional,
    hydrationStatus: row.hydrationStatus,
    hydratedAt: row.hydratedAt?.toISOString() ?? null,
    productionGateReason: reason,
  };
}
