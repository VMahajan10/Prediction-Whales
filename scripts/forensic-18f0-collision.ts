#!/usr/bin/env tsx
import "../tests/preload-env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletLedgerEvents } from "@/lib/crossmarket/store/schema";
import { buildCanonicalChainLogIdentity } from "@/lib/walletLedger/canonicalChainIdentity";

const WALLET = "0x18f0faf72b241dc55094ae704987e391c2a23d5e";
const DEDUPE_KEY =
  "chain|137|0x311d50cbc0773e6b693e44855040353e84e9ece2f6d65f9dabc731b9b9027da0|1013";
const TX_HASH =
  "0x311d50cbc0773e6b693e44855040353e84e9ece2f6d65f9dabc731b9b9027da0";
const LOG_INDEX = 1013;

async function main() {
  const db = getDb();
  const wallet = WALLET.toLowerCase();
  const canonicalIdentity = buildCanonicalChainLogIdentity({
    txHash: TX_HASH,
    logIndex: LOG_INDEX,
  });

  const byDedupe = await db
    .select()
    .from(walletLedgerEvents)
    .where(
      and(
        eq(walletLedgerEvents.walletAddress, wallet),
        eq(walletLedgerEvents.dedupeKey, DEDUPE_KEY)
      )
    );

  const byCanonical = await db
    .select()
    .from(walletLedgerEvents)
    .where(
      and(
        eq(walletLedgerEvents.walletAddress, wallet),
        eq(walletLedgerEvents.canonicalIdentity, canonicalIdentity)
      )
    );

  const byPhysical = await db
    .select()
    .from(walletLedgerEvents)
    .where(
      and(
        eq(walletLedgerEvents.walletAddress, wallet),
        sql`lower(${walletLedgerEvents.txHash}) = ${TX_HASH.toLowerCase()}`,
        eq(walletLedgerEvents.logIndex, String(LOG_INDEX))
      )
    );

  const globalDedupe = await db
    .select()
    .from(walletLedgerEvents)
    .where(eq(walletLedgerEvents.dedupeKey, DEDUPE_KEY));

  console.log(
    JSON.stringify(
      {
        incoming: {
          canonicalIdentity,
          dedupeKey: DEDUPE_KEY,
          txHash: TX_HASH,
          logIndex: LOG_INDEX,
        },
        queryA_sameCanonicalIdentity_for18f0: {
          count: byCanonical.length,
          ids: byCanonical.map((r) => r.id),
          rows: byCanonical,
        },
        queryB_sameTxLogIndex_for18f0: {
          count: byPhysical.length,
          ids: byPhysical.map((r) => r.id),
          rows: byPhysical,
        },
        queryC_sameDedupeKey_for18f0: {
          count: byDedupe.length,
          ids: byDedupe.map((r) => r.id),
          rows: byDedupe,
        },
        queryC_globalDedupeKey: {
          count: globalDedupe.length,
          ids: globalDedupe.map((r) => r.id),
          rows: globalDedupe,
        },
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
