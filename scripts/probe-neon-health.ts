#!/usr/bin/env tsx
import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { normalizeWalletAddress } from "@/lib/walletLedger/indexed/store/persistWalletHistory";

const WALLET =
  process.argv[2] ?? "0x7e5972bfc25819775ee5a9d4f191919375487b8b";

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await fn();
  console.log(`${label}Ms=${Date.now() - started}`);
  return result;
}

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.log(JSON.stringify({ healthy: false, reason: "DATABASE_URL unset" }));
    process.exit(1);
  }

  const db = getDb();
  const wallet = normalizeWalletAddress(WALLET);

  try {
    await timed("select1", () => db.execute(sql`SELECT 1`));
    const countRows = await timed("eventCount", () =>
      db.execute(
        sql`SELECT count(*)::int AS c FROM wallet_ledger_events WHERE wallet_address = ${wallet}`
      )
    );
    const coverageRows = await timed("coverage", () =>
      db.execute(
        sql`SELECT wallet_address, last_indexed_block, event_history_complete FROM wallet_history_coverage WHERE wallet_address = ${wallet} LIMIT 1`
      )
    );

    console.log(
      JSON.stringify(
        {
          healthy: true,
          wallet,
          eventCount: countRows.rows[0]?.c ?? 0,
          coverage: coverageRows.rows[0] ?? null,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          healthy: false,
          wallet,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

void main();
