#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { walletLedgerEvents } from "@/lib/crossmarket/store/schema";
import {
  classifyChainEventIdentity,
} from "@/lib/walletLedger/canonicalChainIdentity";
import { filterChainAuthoritativeEvents } from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { assessUnresolvedChainOrder } from "@/lib/walletLedger/indexed/store/unresolvedChainOrder";

const WALLETS = [
  "0x40b96182a35fbe3c2bb4162e036ecf0c786db002",
  "0x4e56f1ddaa8f5328036c449b89e731ec748cdee1",
  "0x2a69660046d7acc4ab204d7cc5ba78b0776cd2f7",
];

async function main() {
  if (!isDatabaseEnabled()) {
    console.error("no db");
    process.exit(1);
  }
  const db = getDb();
  for (const wallet of WALLETS) {
    const normalized = wallet.toLowerCase();
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        withLogIndex: sql<number>`count(*) filter (where ${walletLedgerEvents.logIndex} is not null)::int`,
        withCanonical: sql<number>`count(*) filter (where ${walletLedgerEvents.canonicalIdentity} is not null)::int`,
      })
      .from(walletLedgerEvents)
      .where(sql`${walletLedgerEvents.walletAddress} = ${normalized} and ${walletLedgerEvents.source} = 'polygon'`);
    const events = await loadPersistedWalletEvents(normalized);
    const authoritative = filterChainAuthoritativeEvents(events);
    const classD = authoritative.filter(
      (event) => classifyChainEventIdentity(event) === "unresolved_chain_log"
    ).length;
    const unresolved = assessUnresolvedChainOrder(events);
    console.log(
      JSON.stringify(
        {
          wallet: normalized,
          dbPolygonRows: row,
          authoritative: authoritative.length,
          classD,
          unresolved,
        },
        null,
        2
      )
    );
  }
}

void main();
