import "server-only";

import { eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { walletApiSyncState } from "@/lib/crossmarket/store/schema";
import { syncWalletApiPositions } from "@/lib/polymarketDataApi/positionsStore";
import { fetchV2PositionsPage } from "@/lib/polymarketDataApi/positions";

/** Wallets with more than this many CLOSED pages use async full sync. */
export const LARGE_WALLET_CLOSED_PAGE_THRESHOLD = 200;
export const CLOSED_PAGE_SIZE = 500;

const inFlight = new Set<string>();

function normalizeWallet(wallet: string): string {
  return wallet.toLowerCase();
}

export async function probeLargeClosedWallet(
  wallet: string
): Promise<boolean> {
  let cursor: string | undefined;
  let pages = 0;
  while (pages < LARGE_WALLET_CLOSED_PAGE_THRESHOLD) {
    const res = await fetchV2PositionsPage(wallet, {
      status: "CLOSED",
      cursor,
      limit: CLOSED_PAGE_SIZE,
    });
    pages++;
    const pag = res.pagination;
    if (!pag?.has_more || !pag.next_cursor) return false;
    cursor = pag.next_cursor;
  }
  return true;
}

export async function markFullSyncStatus(
  wallet: string,
  status: "idle" | "running" | "complete" | "failed"
): Promise<void> {
  if (!isDatabaseEnabled()) return;
  const db = getDb();
  const w = normalizeWallet(wallet);
  await db
    .insert(walletApiSyncState)
    .values({
      walletAddress: w,
      fullSyncStatus: status,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: walletApiSyncState.walletAddress,
      set: {
        fullSyncStatus: status,
        updatedAt: new Date(),
      },
    });
}

export function isWalletPositionsSyncRunning(wallet: string): boolean {
  return inFlight.has(normalizeWallet(wallet));
}

export async function startBackgroundWalletPositionsSync(
  wallet: string,
  options?: { forceFull?: boolean }
): Promise<void> {
  const w = normalizeWallet(wallet);
  if (inFlight.has(w)) return;
  inFlight.add(w);
  await markFullSyncStatus(w, "running");
  void (async () => {
    try {
      await syncWalletApiPositions(w, { forceFull: options?.forceFull ?? true });
      await markFullSyncStatus(w, "complete");
    } catch (err) {
      console.error("[backgroundPositionsSync] failed", w, err);
      await markFullSyncStatus(w, "failed");
    } finally {
      inFlight.delete(w);
    }
  })();
}

export async function ensureWalletPositionsSynced(
  wallet: string,
  options?: { forceFull?: boolean }
): Promise<"ready" | "syncing"> {
  if (!isDatabaseEnabled()) return "ready";
  const w = normalizeWallet(wallet);
  const state = await import("@/lib/polymarketDataApi/positionsStore").then(
    (m) => m.loadWalletApiSyncState(w)
  );
  if (state?.fullSyncStatus === "running" || inFlight.has(w)) {
    return "syncing";
  }
  const needsFull =
    options?.forceFull ||
    !state ||
    !state.lastFullSyncAt ||
    Date.now() - state.lastFullSyncAt.getTime() > 7 * 24 * 60 * 60 * 1000;

  if (!needsFull) return "ready";

  const large = await probeLargeClosedWallet(w);
  if (large) {
    await startBackgroundWalletPositionsSync(w, { forceFull: true });
    return "syncing";
  }

  await syncWalletApiPositions(w, { forceFull: true });
  return "ready";
}
