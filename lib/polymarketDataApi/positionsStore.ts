import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { isDatabaseEnabled, getDb } from "@/lib/crossmarket/store/db";
import {
  walletApiPositions,
  walletApiSyncState,
} from "@/lib/crossmarket/store/schema";
import { resolveCategoryLabelsByEventId } from "@/lib/polymarketDataApi/eventTags";
import { fetchAllV2Positions } from "@/lib/polymarketDataApi/positions";
import { fetchV2HeadlineRealizedPnl } from "@/lib/polymarketDataApi/userPnl";
import {
  reconciliationGapPercent,
  reconciliationPasses,
} from "@/lib/polymarketDataApi/reconciliation";
import {
  invalidateWalletProfitFactorStatsCache,
  setCachedWalletProfitFactorStats,
} from "@/lib/polymarketDataApi/profitFactorStatsCache";
import { computeWalletProfitFactorStatsFromDb } from "@/lib/polymarketDataApi/computeWalletProfitFactorFromDb";
import type { V2PositionRow } from "@/lib/polymarketDataApi/types";

const INCREMENTAL_BUFFER_SEC = 3600;
const FULL_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeWallet(wallet: string): string {
  return wallet.toLowerCase();
}

function rowToInsert(
  wallet: string,
  p: V2PositionRow,
  categoryLabel: string | null
) {
  return {
    walletAddress: wallet,
    tokenId: p.token_id,
    conditionId: p.condition_id ?? null,
    status: String(p.status ?? "UNKNOWN"),
    realizedPnl: Number(p.realized_pnl ?? 0),
    unrealizedPnl: Number(p.unrealized_pnl ?? 0),
    totalPnl: Number(p.total_pnl ?? 0),
    currentPrice:
      p.current_price != null ? Number(p.current_price) : null,
    redeemable: Boolean(p.redeemable),
    eventId: p.event_id != null ? String(p.event_id) : null,
    eventSlug: p.event_slug ?? null,
    categoryLabel,
    title: p.title ?? null,
    lastEventAt: Number(p.last_event_at ?? 0),
    firstEntryAt:
      p.first_entry_at != null ? Number(p.first_entry_at) : null,
    syncedAt: new Date(),
  };
}

function sqlLiteral(value: string | null): string {
  if (value == null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function dedupeRowsByToken(
  rows: ReturnType<typeof rowToInsert>[]
): ReturnType<typeof rowToInsert>[] {
  const byToken = new Map<string, ReturnType<typeof rowToInsert>>();
  for (const row of rows) {
    byToken.set(row.tokenId, row);
  }
  return [...byToken.values()];
}

async function upsertPositionRows(
  rows: ReturnType<typeof rowToInsert>[]
): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const unique = dedupeRowsByToken(rows);
  const chunkSize = 80;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const values = chunk
      .map(
        (r) =>
          `(${sqlLiteral(r.walletAddress)}, ${sqlLiteral(r.tokenId)}, ${sqlLiteral(r.conditionId)}, ${sqlLiteral(r.status)}, ${r.realizedPnl}, ${r.unrealizedPnl}, ${r.totalPnl}, ${r.currentPrice ?? "NULL"}, ${r.redeemable}, ${sqlLiteral(r.eventId)}, ${sqlLiteral(r.eventSlug)}, ${sqlLiteral(r.categoryLabel)}, ${sqlLiteral(r.title)}, ${r.lastEventAt}, ${r.firstEntryAt ?? "NULL"}, NOW())`
      )
      .join(",\n");
    const statement = `
      INSERT INTO wallet_api_positions (
        wallet_address, token_id, condition_id, status,
        realized_pnl, unrealized_pnl, total_pnl, current_price, redeemable,
        event_id, event_slug, category_label, title,
        last_event_at, first_entry_at, synced_at
      ) VALUES ${values}
      ON CONFLICT (wallet_address, token_id) DO UPDATE SET
        condition_id = EXCLUDED.condition_id,
        status = EXCLUDED.status,
        realized_pnl = EXCLUDED.realized_pnl,
        unrealized_pnl = EXCLUDED.unrealized_pnl,
        total_pnl = EXCLUDED.total_pnl,
        current_price = EXCLUDED.current_price,
        redeemable = EXCLUDED.redeemable,
        event_id = EXCLUDED.event_id,
        event_slug = EXCLUDED.event_slug,
        category_label = EXCLUDED.category_label,
        title = EXCLUDED.title,
        last_event_at = EXCLUDED.last_event_at,
        first_entry_at = EXCLUDED.first_entry_at,
        synced_at = EXCLUDED.synced_at
    `;
    await db.execute(sql.raw(statement));
  }
}

export async function loadWalletApiSyncState(wallet: string) {
  if (!isDatabaseEnabled()) return null;
  const db = getDb();
  const w = normalizeWallet(wallet);
  const rows = await db
    .select()
    .from(walletApiSyncState)
    .where(eq(walletApiSyncState.walletAddress, w))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadCachedClosedPositions(wallet: string) {
  if (!isDatabaseEnabled()) return [];
  const db = getDb();
  const w = normalizeWallet(wallet);
  return db
    .select()
    .from(walletApiPositions)
    .where(
      and(
        eq(walletApiPositions.walletAddress, w),
        eq(walletApiPositions.status, "CLOSED")
      )
    );
}

export async function sumClosedRealizedFromCache(wallet: string): Promise<number> {
  if (!isDatabaseEnabled()) return 0;
  const db = getDb();
  const r = await db.execute(sql`
    SELECT COALESCE(SUM(realized_pnl), 0) AS s
    FROM wallet_api_positions
    WHERE lower(wallet_address) = lower(${wallet})
      AND status = 'CLOSED'
  `);
  const row = r.rows[0] as { s: number };
  return Number(row?.s ?? 0);
}

export async function syncWalletApiPositions(
  wallet: string,
  options?: { forceFull?: boolean; maxClosedPages?: number }
): Promise<{
  fetched: number;
  headlineRealizedPnl: number | null;
  positionsSumClosedRealized: number;
  reconciliationGapPct: number | null;
  reconciliationPassed: boolean;
}> {
  const w = normalizeWallet(wallet);
  const state = await loadWalletApiSyncState(w);
  const now = Date.now();
  const needsFull =
    options?.forceFull ||
    !state ||
    !state.lastFullSyncAt ||
    now - state.lastFullSyncAt.getTime() > FULL_SYNC_INTERVAL_MS;

  const start =
    !needsFull && state && state.maxLastEventAt > 0
      ? Math.max(0, state.maxLastEventAt - INCREMENTAL_BUFFER_SEC)
      : undefined;

  const fetchedRows = await fetchAllV2Positions(w, {
    start,
    maxClosedPages: options?.maxClosedPages,
  });
  const db = getDb();
  const cachedCategories = await db
    .select({
      eventId: walletApiPositions.eventId,
      categoryLabel: walletApiPositions.categoryLabel,
    })
    .from(walletApiPositions)
    .where(eq(walletApiPositions.walletAddress, w));
  const categoryByEvent = new Map<string, string>();
  for (const row of cachedCategories) {
    if (row.eventId && row.categoryLabel) {
      categoryByEvent.set(row.eventId, row.categoryLabel);
    }
  }
  const allEventIds = [
    ...new Set(
      fetchedRows
        .map((p) => (p.event_id != null ? String(p.event_id) : ""))
        .filter(Boolean)
    ),
  ];
  const missingEventIds = needsFull
    ? allEventIds
    : allEventIds.filter((id) => !categoryByEvent.has(id));
  const MAX_CATEGORY_RESOLVE_PER_SYNC = 800;
  const resolved = await resolveCategoryLabelsByEventId(
    missingEventIds.slice(0, MAX_CATEGORY_RESOLVE_PER_SYNC)
  );
  for (const [id, label] of resolved) categoryByEvent.set(id, label);

  const inserts = fetchedRows.map((p) => {
    const eid = p.event_id != null ? String(p.event_id) : "";
    return rowToInsert(
      w,
      p,
      eid ? categoryByEvent.get(eid) ?? null : null
    );
  });
  await upsertPositionRows(inserts);

  const positionsSumClosedRealized = await sumClosedRealizedFromCache(w);
  const headlineRealizedPnl = await fetchV2HeadlineRealizedPnl(w);
  const reconciliationGapPct = headlineRealizedPnl != null
    ? reconciliationGapPercent(positionsSumClosedRealized, headlineRealizedPnl)
    : null;
  const reconciliationPassed = reconciliationPasses(reconciliationGapPct);

  const maxLast = fetchedRows.reduce(
    (m, p) => Math.max(m, Number(p.last_event_at ?? 0)),
    state?.maxLastEventAt ?? 0
  );

  const mergedMax = Math.max(state?.maxLastEventAt ?? 0, maxLast);
  const lastFullSyncAt =
    needsFull ? new Date() : (state?.lastFullSyncAt ?? new Date());
  const updatedAt = new Date();
  await db
    .insert(walletApiSyncState)
    .values({
      walletAddress: w,
      maxLastEventAt: mergedMax,
      headlineRealizedPnl,
      positionsSumClosedRealized,
      reconciliationGapPct,
      reconciliationPassed,
      lastFullSyncAt,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: walletApiSyncState.walletAddress,
      set: {
        maxLastEventAt: mergedMax,
        headlineRealizedPnl,
        positionsSumClosedRealized,
        reconciliationGapPct,
        reconciliationPassed,
        lastFullSyncAt,
        updatedAt,
      },
    });

  if (!reconciliationPassed) {
    console.warn("[walletApiPositions] reconciliation gap", {
      wallet: w,
      positionsSumClosedRealized,
      headlineRealizedPnl,
      reconciliationGapPct,
    });
  }

  invalidateWalletProfitFactorStatsCache(w);
  if (reconciliationPassed) {
    const syncUpdatedAt = updatedAt.getTime();
    void (async () => {
      try {
        const stats = await computeWalletProfitFactorStatsFromDb(w);
        if (stats.availability === "verified") {
          await setCachedWalletProfitFactorStats(w, stats, syncUpdatedAt);
        }
      } catch (err) {
        console.warn("[walletApiPositions] PF cache warm failed", w, err);
      }
    })();
  }

  return {
    fetched: fetchedRows.length,
    headlineRealizedPnl,
    positionsSumClosedRealized,
    reconciliationGapPct,
    reconciliationPassed,
  };
}
