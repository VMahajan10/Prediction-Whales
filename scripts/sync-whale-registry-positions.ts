#!/usr/bin/env tsx
/**
 * Sync Polymarket v2 positions + reconciliation for whale_registry wallets.
 * Throttled for Data API rate limits. Writes progress to stderr; final JSON summary to stdout.
 *
 * SYNC_REGISTRY_PASS=small (default): ascending resolved_bets_count; defer wallets with >200 CLOSED pages.
 * SYNC_REGISTRY_PASS=large: wallets in SYNC_REGISTRY_LARGE_QUEUE file (+ estimate >50k).
 */
import "../tests/preload-env";
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { LARGE_WALLET_CLOSED_PAGE_THRESHOLD } from "@/lib/polymarketDataApi/backgroundPositionsSync";
import { WalletClosedPageCapExceeded } from "@/lib/polymarketDataApi/positions";
import { syncWalletApiPositions } from "@/lib/polymarketDataApi/positionsStore";
import { resolveWalletProfitFactorStats } from "@/lib/polymarketDataApi/profitFactorService";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";

type LargeQueueEntry = {
  wallet: string;
  estimatedPositions?: number;
  reason: string;
  deferredAt?: string;
};

type LargeQueueFile = {
  createdAt?: string;
  threshold?: number;
  closedPageCap?: number;
  wallets: LargeQueueEntry[];
};

const WALLET_PAUSE_MS = Number(process.env.SYNC_WALLET_PAUSE_MS ?? "2500");
const START_OFFSET = Number(process.env.SYNC_REGISTRY_OFFSET ?? "0");
const LIMIT = process.env.SYNC_REGISTRY_LIMIT
  ? Number(process.env.SYNC_REGISTRY_LIMIT)
  : undefined;
const PASS = (process.env.SYNC_REGISTRY_PASS ?? "small").toLowerCase();
const MAX_POSITIONS_SMALL_PASS = Number(
  process.env.SYNC_REGISTRY_MAX_POSITIONS ?? "50000"
);
const LARGE_QUEUE_PATH =
  process.env.SYNC_REGISTRY_LARGE_QUEUE ??
  "/tmp/whale-registry-large-pass-queue.json";
const VERIFY_PROGRESS_EVERY = Number(
  process.env.SYNC_REGISTRY_VERIFY_EVERY ?? "25"
);
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const SMALL_PASS_MAX_CLOSED_PAGES = Number(
  process.env.SYNC_REGISTRY_MAX_CLOSED_PAGES ??
    String(LARGE_WALLET_CLOSED_PAGE_THRESHOLD)
);

function readLargeQueue(): LargeQueueFile {
  try {
    const raw = JSON.parse(
      readFileSync(LARGE_QUEUE_PATH, "utf8")
    ) as LargeQueueFile;
    return { ...raw, wallets: raw.wallets ?? [] };
  } catch {
    return { wallets: [] };
  }
}

function writeLargeQueue(file: LargeQueueFile): void {
  writeFileSync(LARGE_QUEUE_PATH, JSON.stringify(file, null, 2));
}

function appendToLargeQueue(entry: LargeQueueEntry): void {
  const file = readLargeQueue();
  const wallet = entry.wallet.toLowerCase();
  if (file.wallets.some((w) => w.wallet.toLowerCase() === wallet)) return;
  file.wallets.push({
    ...entry,
    wallet,
    deferredAt: entry.deferredAt ?? new Date().toISOString(),
  });
  writeLargeQueue(file);
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function countVerifiedWallets(): Promise<number> {
  const db = getDb();
  const stateRes = await db.execute(sql`
    SELECT COUNT(*)::int AS verified
    FROM wallet_api_sync_state
    WHERE reconciliation_passed = true
  `);
  return (stateRes.rows[0] as { verified: number }).verified;
}

async function main() {
  if (!isDatabaseEnabled() || !isPrismaEnabled()) {
    console.error("DATABASE_URL and Prisma required");
    process.exit(1);
  }

  const prisma = getPrisma();
  if (!prisma) process.exit(1);

  const rows = await prisma.whaleRegistry.findMany({
    select: { walletAddress: true, resolvedBetsCount: true },
    orderBy: { resolvedBetsCount: "asc" },
  });

  const normalized = rows
    .map((r) => ({
      wallet: r.walletAddress.toLowerCase(),
      estimatedPositions: r.resolvedBetsCount ?? 0,
    }))
    .filter((r) => r.wallet !== ZERO_ADDR);

  const largeCandidates = normalized.filter(
    (r) => r.estimatedPositions > MAX_POSITIONS_SMALL_PASS
  );
  const smallCandidates = normalized.filter(
    (r) => r.estimatedPositions <= MAX_POSITIONS_SMALL_PASS
  );

  let wallets: string[];
  let queuedForLargePass = 0;

  if (PASS === "large") {
    const fromFile = readLargeQueue().wallets.map((w) => w.wallet);
    const fromEstimate = largeCandidates.map((r) => r.wallet);
    wallets = [...new Set([...fromFile, ...fromEstimate])];
    process.stderr.write(
      `large pass: ${wallets.length} wallets (queue file + estimate > ${MAX_POSITIONS_SMALL_PASS})\n`
    );
  } else {
    const initialQueue: LargeQueueEntry[] = largeCandidates.map((r) => ({
      wallet: r.wallet,
      estimatedPositions: r.estimatedPositions,
      reason: `resolved_bets_count>${MAX_POSITIONS_SMALL_PASS}`,
    }));
    const existing = readLargeQueue();
    const byWallet = new Map<string, LargeQueueEntry>();
    for (const e of existing.wallets) byWallet.set(e.wallet.toLowerCase(), e);
    for (const e of initialQueue) {
      const w = e.wallet.toLowerCase();
      if (!byWallet.has(w)) byWallet.set(w, e);
    }
    queuedForLargePass = byWallet.size;
    writeLargeQueue({
      ...existing,
      createdAt: existing.createdAt ?? new Date().toISOString(),
      threshold: MAX_POSITIONS_SMALL_PASS,
      closedPageCap: SMALL_PASS_MAX_CLOSED_PAGES,
      wallets: [...byWallet.values()],
    });
    wallets = smallCandidates
      .map((r) => r.wallet)
      .filter((w) => !byWallet.has(w));
    process.stderr.write(
      `small pass: ${wallets.length} wallets (ascending position count); ` +
        `CLOSED cap ${SMALL_PASS_MAX_CLOSED_PAGES} pages; ` +
        `${queuedForLargePass} pre-queued → ${LARGE_QUEUE_PATH}\n`
    );
  }

  if (START_OFFSET > 0) wallets = wallets.slice(START_OFFSET);
  if (LIMIT != null && LIMIT > 0) wallets = wallets.slice(0, LIMIT);

  const total = wallets.length;
  let synced = 0;
  let failed = 0;
  let deferredToLargePass = 0;
  let processed = 0;

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    process.stderr.write(
      `[${i + 1}/${total}] sync ${wallet.slice(0, 10)}…\n`
    );
    try {
      await syncWalletApiPositions(wallet, {
        forceFull: true,
        maxClosedPages:
          PASS === "small" ? SMALL_PASS_MAX_CLOSED_PAGES : undefined,
      });
      synced++;
    } catch (err) {
      if (
        PASS === "small" &&
        err instanceof WalletClosedPageCapExceeded
      ) {
        deferredToLargePass++;
        appendToLargeQueue({
          wallet,
          reason: `closed_pages>${err.maxClosedPages}`,
        });
        process.stderr.write(
          `  deferred (>${err.maxClosedPages} CLOSED pages) → large pass queue\n`
        );
      } else {
        failed++;
        console.error(`  failed ${wallet}:`, err);
      }
    }
    processed++;
    if (
      VERIFY_PROGRESS_EVERY > 0 &&
      processed % VERIFY_PROGRESS_EVERY === 0
    ) {
      const verified = await countVerifiedWallets();
      process.stderr.write(
        `[progress] processed ${processed}/${total} — verified wallets: ${verified}\n`
      );
    }
    if (i < wallets.length - 1) await sleep(WALLET_PAUSE_MS);
  }

  const db = getDb();
  const regTotal = rows.length;
  const stateRes = await db.execute(sql`
    SELECT
      COUNT(*)::int AS in_sync_table,
      COUNT(*) FILTER (WHERE reconciliation_passed)::int AS verified
    FROM wallet_api_sync_state
  `);
  const stateRow = stateRes.rows[0] as {
    in_sync_table: number;
    verified: number;
  };

  let pf12 = 0;
  let pf15 = 0;
  const verifiedWallets = await db.execute(sql`
    SELECT wallet_address FROM wallet_api_sync_state WHERE reconciliation_passed = true
  `);
  for (const row of verifiedWallets.rows as { wallet_address: string }[]) {
    const stats = await resolveWalletProfitFactorStats(row.wallet_address, {
      forceSync: false,
    });
    if (!stats.verified || !stats.overall) continue;
    const n = stats.overall.positionCount;
    const pf = stats.overall.profitFactor;
    if (n < 30) continue;
    if (pf != null && pf >= 1.2) pf12++;
    if (pf != null && pf >= 1.5) pf15++;
  }

  const summary = {
    pass: PASS,
    registryTotal: regTotal,
    processedThisRun: total,
    syncedOk: synced,
    syncFailed: failed,
    deferredToLargePassThisRun: deferredToLargePass,
    queuedForLargePass:
      PASS === "small" ? readLargeQueue().wallets.length : readLargeQueue().wallets.length,
    largeQueuePath: LARGE_QUEUE_PATH,
    closedPageCap: PASS === "small" ? SMALL_PASS_MAX_CLOSED_PAGES : null,
    syncStateRows: stateRow.in_sync_table,
    verifiedCount: stateRow.verified,
    verifiedPfGte12Min30Positions: pf12,
    verifiedPfGte15Min30Positions: pf15,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
