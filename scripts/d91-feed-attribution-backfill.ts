#!/usr/bin/env tsx
/**
 * One-time controlled backfill for d91 feed_trades attribution.
 * Default: dry-run (zero writes). Pass --execute to mutate.
 */
import "../tests/preload-env";
import { writeFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";
import {
  DEFAULT_D91_BACKFILL_RESULT_PATH,
  DEFAULT_D91_REPLAY_ARTIFACT_PATH,
  assertionsPass,
  buildDryRunLines,
  buildPlanEntriesFromArtifact,
  executeD91FeedAttributionBackfill,
  fetchFeedTradesByIds,
  formatDryRunReport,
  loadD91ReplayArtifact,
  buildAssertionReport,
} from "@/lib/feed/d91FeedAttributionBackfill";

config({ path: ".env.local" });
config({ path: ".env" });

const EXECUTE = process.argv.includes("--execute");
const artifactArgIdx = process.argv.indexOf("--artifact");
const artifactPath =
  artifactArgIdx >= 0 && process.argv[artifactArgIdx + 1]
    ? process.argv[artifactArgIdx + 1]
    : DEFAULT_D91_REPLAY_ARTIFACT_PATH;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not configured");
    process.exit(1);
  }

  const artifact = loadD91ReplayArtifact(artifactPath);
  const planEntries = buildPlanEntriesFromArtifact(artifact);
  const tradeIds = planEntries.map((e) => e.tradeId);

  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();

  try {
    const dbRows = await fetchFeedTradesByIds(client, tradeIds);
    const report = buildAssertionReport(artifact, dbRows, tradeIds);
    const lines = buildDryRunLines(artifact, dbRows);
    console.log(formatDryRunReport(report, lines));

    if (!EXECUTE) {
      console.log("");
      console.log("Dry-run complete — no database writes performed.");
      if (!assertionsPass(report)) {
        process.exit(1);
      }
      return;
    }

    console.log("");
    console.log("Execute mode: all assertions must pass before writing.");
    if (!assertionsPass(report)) {
      process.exit(1);
    }

    const outcome = await executeD91FeedAttributionBackfill({
      client,
      artifact,
      planEntries,
      dryRun: false,
    });

    if (!outcome.ok) {
      console.error(`Backfill aborted: ${outcome.error}`);
      process.exit(1);
    }

    if (!outcome.dryRun) {
      writeFileSync(
        DEFAULT_D91_BACKFILL_RESULT_PATH,
        `${JSON.stringify(outcome.result, null, 2)}\n`,
        "utf8",
      );
      console.log("Post-commit verification:");
      console.log(`  totalRows = ${outcome.result.verification.totalRows}`);
      console.log(`  reattributed = ${outcome.result.verification.reattributed}`);
      console.log(`  unresolved = ${outcome.result.verification.unresolved}`);
      console.log(`  d91Remaining = ${outcome.result.verification.d91Remaining}`);
      console.log(
        `  outsideArtifactModified = ${outcome.result.verification.outsideArtifactModified}`,
      );
      console.log(`Wrote ${DEFAULT_D91_BACKFILL_RESULT_PATH}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
