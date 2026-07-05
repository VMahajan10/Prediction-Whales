/**
 * Paired market catalog — reads mapping identity from Postgres only.
 * Does not touch true_probabilities or EV snapshot columns.
 */

import { ne, sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { marketMappings } from "@/lib/crossmarket/store/schema";
import type { ArbPairMapping } from "@/lib/arbitrageFinder/types";

const TEST_FALLBACK_MATCH_METHOD = "TEST_FALLBACK_PAIR";

export async function loadActiveArbPairMappings(
  limit = 2000
): Promise<ArbPairMapping[]> {
  if (!isDatabaseEnabled()) return [];

  const db = getDb();
  const rows = await db
    .select({
      polymarketTokenId: marketMappings.polymarketTokenId,
      kalshiTicker: marketMappings.kalshiTicker,
      orientation: marketMappings.orientation,
      matchMethod: marketMappings.matchMethod,
    })
    .from(marketMappings)
    .where(ne(marketMappings.matchMethod, TEST_FALLBACK_MATCH_METHOD))
    .limit(limit);

  return rows.map((row) => ({
    polymarketTokenId: row.polymarketTokenId.toLowerCase(),
    kalshiTicker: row.kalshiTicker.toUpperCase(),
    orientation: row.orientation === "inverted" ? "inverted" : "same",
    matchMethod: row.matchMethod,
  }));
}

export async function countActiveArbPairMappings(): Promise<number> {
  if (!isDatabaseEnabled()) return 0;

  const db = getDb();
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(marketMappings)
    .where(ne(marketMappings.matchMethod, TEST_FALLBACK_MATCH_METHOD));

  return result[0]?.count ?? 0;
}
