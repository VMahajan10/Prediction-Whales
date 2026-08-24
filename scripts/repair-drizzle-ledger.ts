/**
 * Repair drizzle.__drizzle_migrations baseline + register 0019/0021 in journal.
 * Does NOT execute historical migration SQL — only inserts ledger rows.
 * Run: npx tsx --tsconfig tsconfig.json scripts/repair-drizzle-ledger.ts [--apply]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import pg from "pg";

config({ path: ".env.local" });
config({ path: ".env" });

const APPLY = process.argv.includes("--apply");
const DRY_RUN_MIGRATE = process.argv.includes("--dry-run-migrate");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not configured");
  process.exit(1);
}

const DRIZZLE_DIR = join(process.cwd(), "drizzle");
const JOURNAL_PATH = join(DRIZZLE_DIR, "meta/_journal.json");

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

type Journal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

type Verification = {
  tag: string;
  effect: string;
  present: boolean;
  safeToBaseline: boolean;
  detail: string;
};

function hashSqlFile(tag: string): string {
  const body = readFileSync(join(DRIZZLE_DIR, `${tag}.sql`));
  return createHash("sha256").update(body).digest("hex");
}

function loadJournal(): Journal {
  return JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as Journal;
}

async function columnExists(
  client: pg.PoolClient,
  table: string,
  column: string
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return res.rowCount !== null && res.rowCount > 0;
}

async function tableExists(
  client: pg.PoolClient,
  table: string
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return res.rowCount !== null && res.rowCount > 0;
}

async function indexExists(
  client: pg.PoolClient,
  indexName: string
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [indexName]
  );
  return res.rowCount !== null && res.rowCount > 0;
}

async function enumHasValue(
  client: pg.PoolClient,
  enumName: string,
  value: string
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM pg_enum e
     JOIN pg_type t ON e.enumtypid = t.oid
     WHERE t.typname = $1 AND e.enumlabel = $2`,
    [enumName, value]
  );
  return res.rowCount !== null && res.rowCount > 0;
}

async function constraintCheckIncludes(
  client: pg.PoolClient,
  table: string,
  constraint: string,
  fragment: string
): Promise<boolean> {
  const res = await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class rel ON c.conrelid = rel.oid
     JOIN pg_namespace n ON rel.relnamespace = n.oid
     WHERE n.nspname = 'public' AND rel.relname = $1 AND c.conname = $2`,
    [table, constraint]
  );
  const def = res.rows[0]?.def as string | undefined;
  return Boolean(def && def.includes(fragment));
}

async function verifyMigrations(
  client: pg.PoolClient
): Promise<Verification[]> {
  const checks: Array<{
    tag: string;
    effect: string;
    run: () => Promise<boolean>;
    detail: string;
  }> = [
    {
      tag: "0003_match_method_test_fallback",
      effect: "market_mappings match_method allows TEST_FALLBACK_PAIR",
      run: () =>
        constraintCheckIncludes(
          client,
          "market_mappings",
          "market_mappings_match_method_check",
          "TEST_FALLBACK_PAIR"
        ),
      detail: "market_mappings_match_method_check contains TEST_FALLBACK_PAIR",
    },
    {
      tag: "0004_x_detection_engine",
      effect: "whale_registry table",
      run: () => tableExists(client, "whale_registry"),
      detail: "public.whale_registry exists",
    },
    {
      tag: "0004_x_detection_engine",
      effect: "x_post_queue table",
      run: () => tableExists(client, "x_post_queue"),
      detail: "public.x_post_queue exists",
    },
    {
      tag: "0004_x_detection_engine",
      effect: "x_post_log table",
      run: () => tableExists(client, "x_post_log"),
      detail: "public.x_post_log exists",
    },
    {
      tag: "0004_lean_cyclops",
      effect: "market_mappings table",
      run: () => tableExists(client, "market_mappings"),
      detail: "public.market_mappings exists",
    },
    {
      tag: "0004_lean_cyclops",
      effect: "trader_ev_analytics table",
      run: () => tableExists(client, "trader_ev_analytics"),
      detail: "public.trader_ev_analytics exists",
    },
    {
      tag: "0004_lean_cyclops",
      effect: "true_probabilities table",
      run: () => tableExists(client, "true_probabilities"),
      detail: "public.true_probabilities exists",
    },
    {
      tag: "0005_x_post_queue_variant_id",
      effect: "x_post_queue.variant_id",
      run: () => columnExists(client, "x_post_queue", "variant_id"),
      detail: "x_post_queue.variant_id column",
    },
    {
      tag: "0006_x_post_scheduled_publish",
      effect: "x_post_queue.x_tweet_id",
      run: () => columnExists(client, "x_post_queue", "x_tweet_id"),
      detail: "x_post_queue.x_tweet_id column",
    },
    {
      tag: "0007_x_post_queue_decision_lock",
      effect: "x_post_queue.decided_by/decided_at",
      run: async () =>
        (await columnExists(client, "x_post_queue", "decided_by")) &&
        (await columnExists(client, "x_post_queue", "decided_at")),
      detail: "x_post_queue.decided_by + decided_at",
    },
    {
      tag: "0008_x_post_queue_ev_gloss",
      effect: "x_post_queue.ev_gloss",
      run: () => columnExists(client, "x_post_queue", "ev_gloss"),
      detail: "x_post_queue.ev_gloss column",
    },
    {
      tag: "0009_kalshi_shadow_trades",
      effect: "kalshi_shadow_trades table",
      run: () => tableExists(client, "kalshi_shadow_trades"),
      detail: "public.kalshi_shadow_trades exists",
    },
    {
      tag: "0010_x_post_queue_media",
      effect: "x_post_queue media columns",
      run: async () =>
        (await columnExists(client, "x_post_queue", "x_media_id")) &&
        (await columnExists(client, "x_post_queue", "receipt_media_url")),
      detail: "x_post_queue.x_media_id + receipt_media_url",
    },
    {
      tag: "0011_kalshi_shadow_float8",
      effect: "kalshi_shadow_trades.size is double precision",
      run: async () => {
        const res = await client.query(
          `SELECT data_type FROM information_schema.columns
           WHERE table_schema='public' AND table_name='kalshi_shadow_trades' AND column_name='size'`
        );
        return res.rows[0]?.data_type === "double precision";
      },
      detail: "kalshi_shadow_trades.size :: double precision",
    },
    {
      tag: "0012_kalshi_shadow_taker_book_side",
      effect: "kalshi_shadow_trades direction columns",
      run: async () =>
        (await columnExists(client, "kalshi_shadow_trades", "taker_side")) &&
        (await columnExists(client, "kalshi_shadow_trades", "taker_outcome_side")) &&
        (await columnExists(client, "kalshi_shadow_trades", "taker_book_side")),
      detail: "kalshi_shadow_trades taker_* columns",
    },
    {
      tag: "0013_x_post_queue_public_telegram",
      effect: "x_post_queue.public_telegram_message_id",
      run: () =>
        columnExists(client, "x_post_queue", "public_telegram_message_id"),
      detail: "x_post_queue.public_telegram_message_id",
    },
    {
      tag: "0016_x_post_log_rejection_reason",
      effect: "rejection_reason enum + BELOW_RESOLVED_BETS",
      run: async () =>
        (await enumHasValue(client, "rejection_reason", "BELOW_RESOLVED_BETS")),
      detail: "rejection_reason enum value BELOW_RESOLVED_BETS",
    },
    {
      tag: "0017_kalshi_shadow_trades_trade_id_unique",
      effect: "kalshi_shadow_trades PK on trade_id",
      run: async () => {
        const res = await client.query(
          `SELECT 1 FROM pg_constraint c
           JOIN pg_class rel ON c.conrelid = rel.oid
           JOIN pg_namespace n ON rel.relnamespace = n.oid
           WHERE n.nspname='public' AND rel.relname='kalshi_shadow_trades' AND c.contype='p'`
        );
        return res.rowCount !== null && res.rowCount > 0;
      },
      detail: "kalshi_shadow_trades primary key constraint",
    },
    {
      tag: "0018_x_post_log_rejection_reason_values",
      effect: "rejection_reason includes DUPLICATE_TRADE",
      run: () => enumHasValue(client, "rejection_reason", "DUPLICATE_TRADE"),
      detail: "rejection_reason enum value DUPLICATE_TRADE (0018 backfill)",
    },
    {
      tag: "0014_feed_trades",
      effect: "feed_trades table",
      run: () => tableExists(client, "feed_trades"),
      detail: "public.feed_trades exists",
    },
    {
      tag: "0015_true_probabilities_token_unique",
      effect: "true_probabilities PM token unique index",
      run: () =>
        indexExists(client, "true_probabilities_polymarket_token_id_unique"),
      detail: "index true_probabilities_polymarket_token_id_unique",
    },
    {
      tag: "0020_feed_daily_metrics",
      effect: "feed_daily_metrics table",
      run: () => tableExists(client, "feed_daily_metrics"),
      detail: "public.feed_daily_metrics exists",
    },
    {
      tag: "0020_feed_daily_metrics",
      effect: "feed_daily_qualified_whales table",
      run: () => tableExists(client, "feed_daily_qualified_whales"),
      detail: "public.feed_daily_qualified_whales exists",
    },
    {
      tag: "0019_market_category",
      effect: "feed_trades.category",
      run: () => columnExists(client, "feed_trades", "category"),
      detail: "feed_trades.category column",
    },
    {
      tag: "0019_market_category",
      effect: "kalshi_shadow_trades.category",
      run: () => columnExists(client, "kalshi_shadow_trades", "category"),
      detail: "kalshi_shadow_trades.category column",
    },
    {
      tag: "0019_market_category",
      effect: "feed_trades category index",
      run: () => indexExists(client, "feed_trades_category_traded_at_idx"),
      detail: "index feed_trades_category_traded_at_idx",
    },
    {
      tag: "0019_market_category",
      effect: "kalshi_shadow category index",
      run: () =>
        indexExists(client, "kalshi_shadow_trades_category_traded_at_idx"),
      detail: "index kalshi_shadow_trades_category_traded_at_idx",
    },
  ];

  const byTag = new Map<string, Verification[]>();
  for (const check of checks) {
    const present = await check.run();
    const row: Verification = {
      tag: check.tag,
      effect: check.effect,
      present,
      safeToBaseline: present,
      detail: check.detail,
    };
    const list = byTag.get(check.tag) ?? [];
    list.push(row);
    byTag.set(check.tag, list);
  }

  const journal = loadJournal();
  const matrix: Verification[] = [];
  for (const entry of journal.entries) {
    if (entry.tag === "0001_crossmarket_init") continue;
    const rows = byTag.get(entry.tag) ?? [];
    if (rows.length === 0) {
      matrix.push({
        tag: entry.tag,
        effect: "(no automated check — STOP)",
        present: false,
        safeToBaseline: false,
        detail: "missing verification",
      });
      continue;
    }
    const allPresent = rows.every((r) => r.present);
    matrix.push({
      tag: entry.tag,
      effect: rows.map((r) => r.effect).join("; "),
      present: allPresent,
      safeToBaseline: allPresent,
      detail: rows.map((r) => `${r.detail}: ${r.present ? "yes" : "NO"}`).join(" | "),
    });
  }

  const orphan0019 = byTag.get("0019_market_category") ?? [];
  const orphan0019Ok = orphan0019.length > 0 && orphan0019.every((r) => r.present);
  matrix.push({
    tag: "0019_market_category (orphan)",
    effect: orphan0019.map((r) => r.effect).join("; "),
    present: orphan0019Ok,
    safeToBaseline: orphan0019Ok,
    detail: orphan0019.map((r) => `${r.detail}: ${r.present ? "yes" : "NO"}`).join(" | "),
  });

  return matrix;
}

function plannedLedgerInserts(journal: Journal): Array<{
  tag: string;
  hash: string;
  created_at: number;
}> {
  const rows: Array<{ tag: string; hash: string; created_at: number }> = [];
  for (const entry of journal.entries) {
    if (entry.tag === "0001_crossmarket_init") continue;
    rows.push({
      tag: entry.tag,
      hash: hashSqlFile(entry.tag),
      created_at: entry.when,
    });
  }
  return rows;
}

function buildRepairedJournal(journal: Journal): Journal {
  const entries = [...journal.entries];
  const has0019 = entries.some((e) => e.tag === "0019_market_category");
  if (!has0019) {
    entries.push({
      idx: 19,
      version: "7",
      when: 1785464000000,
      tag: "0019_market_category",
      breakpoints: true,
    });
    entries.sort((a, b) => a.idx - b.idx);
  }
  const has0021 = entries.some((e) => e.tag === "0021_whale_registry_hydration_state");
  if (!has0021) {
    entries.push({
      idx: 21,
      version: "7",
      when: 1785466000000,
      tag: "0021_whale_registry_hydration_state",
      breakpoints: true,
    });
    entries.sort((a, b) => a.idx - b.idx);
  }
  return { ...journal, entries };
}

async function main() {
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();

  try {
    const dbInfo = await client.query(`SELECT current_database() AS db, current_user AS usr`);
    console.log("\n=== DB connection ===");
    console.log(JSON.stringify(dbInfo.rows[0], null, 2));

    const before = await client.query(
      `SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`
    );
    console.log("\n=== Ledger BEFORE ===");
    console.log(`count: ${before.rowCount}`);
    for (const row of before.rows) {
      console.log(`  id=${row.id} created_at=${row.created_at} hash=${String(row.hash).slice(0, 16)}...`);
    }

    const matrix = await verifyMigrations(client);
    console.log("\n=== Verification matrix ===");
    console.log("| Migration | Schema effect present? | Safe to baseline? |");
    console.log("| --------- | ---------------------- | ----------------- |");
    let blocked = false;
    for (const row of matrix) {
      const present = row.present ? "yes" : "no";
      const safe = row.safeToBaseline ? "yes" : "no (run via migrate)";
      console.log(`| ${row.tag} | ${present} | ${safe} |`);
      console.log(`  detail: ${row.detail}`);
      if (
        !row.safeToBaseline &&
        !row.tag.includes("0021") &&
        !row.tag.includes("(orphan)")
      ) {
        const inJournal = loadJournal().entries.some((e) => e.tag === row.tag.replace(" (orphan)", ""));
        if (inJournal && row.tag !== "0016_x_post_log_rejection_reason" && row.tag !== "0018_x_post_log_rejection_reason_values" && row.tag !== "0020_feed_daily_metrics") {
          blocked = true;
        }
      }
    }

    const journal = loadJournal();
    const repairedJournal = buildRepairedJournal(journal);
    const tagVerification = (tag: string) =>
      matrix.find((m) => m.tag === tag || m.tag === `${tag} (orphan)`);

    const baselineRows = plannedLedgerInserts(repairedJournal).filter((row) => {
      if (row.tag === "0021_whale_registry_hydration_state") return false;
      return tagVerification(row.tag)?.safeToBaseline === true;
    });

    const skippedBaseline = plannedLedgerInserts(repairedJournal).filter((row) => {
      if (row.tag === "0021_whale_registry_hydration_state") return false;
      return tagVerification(row.tag)?.safeToBaseline !== true;
    });

    if (skippedBaseline.length > 0) {
      console.log("\n=== Skipped baseline (schema not present — will run via migrate) ===");
      for (const row of skippedBaseline) {
        console.log(`  ${row.tag}`);
      }
    }

    if (blocked) {
      console.error("\nABORT: unexpected verification failure.");
      process.exit(1);
    }

    console.log("\n=== Planned ledger INSERTs (no SQL execution) ===");
    for (const row of baselineRows) {
      console.log(
        `  ${row.tag}  created_at=${row.created_at}  hash=${row.hash.slice(0, 16)}...`
      );
    }

    const pending0021Hash = hashSqlFile("0021_whale_registry_hydration_state");
    console.log("\n=== 0021 pending (NOT inserted manually) ===");
    console.log(`  hash=${pending0021Hash}`);
    console.log(`  hydration columns before migrate:`);
    const hydrationCols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='whale_registry'
         AND column_name IN ('hydration_status','hydrated_at','last_hydration_attempt_at','hydration_error')`
    );
    console.log(`  present: ${hydrationCols.rowCount === 0 ? "none (expected)" : hydrationCols.rows.map((r) => r.column_name).join(", ")}`);

    if (!APPLY && !DRY_RUN_MIGRATE) {
      console.log("\nDry run only. Re-run with --apply to repair ledger + journal.");
      return;
    }

    if (APPLY) {
      writeFileSync(JOURNAL_PATH, `${JSON.stringify(repairedJournal, null, 2)}\n`);
      console.log("\n=== Journal repaired on disk ===");
      for (const e of repairedJournal.entries) {
        if (e.tag === "0019_market_category" || e.tag === "0021_whale_registry_hydration_state") {
          console.log(`  idx=${e.idx} when=${e.when} tag=${e.tag}`);
        }
      }

      await client.query("BEGIN");
      try {
        for (const row of baselineRows) {
          const existing = await client.query(
            `SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1 AND created_at = $2`,
            [row.hash, row.created_at]
          );
          if (existing.rowCount && existing.rowCount > 0) {
            console.log(`  skip (already recorded): ${row.tag}`);
            continue;
          }
          await client.query(
            `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
            [row.hash, row.created_at]
          );
          console.log(`  inserted ledger: ${row.tag}`);
        }
        await client.query("COMMIT");
        console.log("\nLedger repair committed.");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      const afterRepair = await client.query(
        `SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`
      );
      const latest = afterRepair.rows[afterRepair.rows.length - 1];
      console.log("\n=== Post-repair ledger ===");
      console.log(`count: ${afterRepair.rowCount}`);
      console.log(`latest created_at: ${latest?.created_at}`);
      const pending = repairedJournal.entries.filter((e) => {
        const hash = hashSqlFile(e.tag);
        const recorded = afterRepair.rows.some(
          (r) => r.hash === hash && Number(r.created_at) === e.when
        );
        return !recorded;
      });
      console.log(`pending migrations (${pending.length}): ${pending.map((p) => p.tag).join(", ") || "(none)"}`);
      const expectedPending = [
        "0016_x_post_log_rejection_reason",
        "0018_x_post_log_rejection_reason_values",
        "0020_feed_daily_metrics",
        "0021_whale_registry_hydration_state",
      ];
      const pendingTags = pending.map((p) => p.tag);
      const ok =
        pendingTags.length === expectedPending.length &&
        expectedPending.every((t) => pendingTags.includes(t));
      if (!ok) {
        console.error("ABORT: unexpected pending set before migrate.");
        console.error(`expected: ${expectedPending.join(", ")}`);
        console.error(`actual:   ${pendingTags.join(", ")}`);
        process.exit(1);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
