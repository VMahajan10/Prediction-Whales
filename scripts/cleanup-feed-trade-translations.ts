/**
 * Re-validate persisted Polymarket feed_trades translations.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.json scripts/cleanup-feed-trade-translations.ts
 *   npx tsx --tsconfig tsconfig.json scripts/cleanup-feed-trade-translations.ts --apply
 *
 * Default is dry-run. Invalid rows are deleted because feed_trades exists only
 * to back the product feed and there is no archival/inactive column.
 */
import { neon } from "@neondatabase/serverless";
import { loadEnvFiles } from "./loadEnv";

loadEnvFiles();

import {
  classifyPersistedPolymarketTranslation,
  revalidatePersistedPolymarketFeedPayload,
} from "@/lib/feed/persistedFeedTranslation";

type FeedTradeRow = {
  trade_id: string;
  payload: unknown;
};

function parseArgs(argv: string[]) {
  return {
    apply: argv.includes("--apply"),
  };
}

async function main(): Promise<void> {
  const { apply } = parseArgs(process.argv.slice(2));

  console.log("\n── feed_trades translation cleanup ──\n");
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}\n`);

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not configured.\n");
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);
  const rows = (await sql`
    SELECT trade_id, payload
    FROM feed_trades
  `) as FeedTradeRow[];

  let unchanged = 0;
  let retranslated = 0;
  let rejected = 0;

  const toUpdate: Array<{ tradeId: string; payload: Record<string, unknown> }> =
    [];
  const toDelete: string[] = [];

  for (const row of rows) {
    const { action, translation } = classifyPersistedPolymarketTranslation(
      row.payload
    );

    if (action === "rejected") {
      rejected += 1;
      toDelete.push(row.trade_id);
      continue;
    }

    if (action === "unchanged") {
      unchanged += 1;
      continue;
    }

    retranslated += 1;
    const validated = revalidatePersistedPolymarketFeedPayload(row.payload);
    if (!validated) {
      rejected += 1;
      retranslated -= 1;
      toDelete.push(row.trade_id);
      continue;
    }
    toUpdate.push({ tradeId: row.trade_id, payload: validated });
  }

  console.log(`Rows inspected:        ${rows.length}`);
  console.log(`Rows already valid:    ${unchanged}`);
  console.log(`Rows re-translated:    ${retranslated}`);
  console.log(`Rows rejected:         ${rejected}`);
  console.log("");

  if (!apply) {
    console.log("Dry run complete — pass --apply to update/delete rows.\n");
    return;
  }

  for (const row of toUpdate) {
    await sql`
      UPDATE feed_trades
      SET payload = ${JSON.stringify(row.payload)}::jsonb,
          updated_at = now()
      WHERE trade_id = ${row.tradeId}
    `;
  }

  for (const tradeId of toDelete) {
    await sql`
      DELETE FROM feed_trades
      WHERE trade_id = ${tradeId}
    `;
  }

  console.log(`Updated payloads:      ${toUpdate.length}`);
  console.log(`Deleted rows:          ${toDelete.length}\n`);
}

main().catch((error) => {
  console.error(
    "[cleanup-feed-trade-translations] failed",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});
