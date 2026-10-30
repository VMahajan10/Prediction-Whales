#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import "../preload-env";

import {
  evaluateFillSources,
  formatEvaluationMarkdown,
} from "@/lib/backtest/fillSourceEvaluation";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";

const TMP = join(process.cwd(), "tmp", "backtest");

function dateToUnixStart(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00.000Z`) / 1000);
}

function dateToUnixEnd(iso: string): number {
  return Math.floor(Date.parse(`${iso}T23:59:59.999Z`) / 1000);
}

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  getDb();
  const start = process.argv[2] ?? "2024-01-01";
  const end = process.argv[3] ?? "2024-12-31";
  const sample = Number(process.argv[4] ?? "30");

  const ev = await evaluateFillSources(
    dateToUnixStart(start),
    dateToUnixEnd(end),
    sample
  );

  mkdirSync(TMP, { recursive: true });
  const md = formatEvaluationMarkdown(ev);
  const jsonPath = join(TMP, "fill-source-evaluation.json");
  const mdPath = join(TMP, "fill-source-evaluation.md");
  writeFileSync(jsonPath, JSON.stringify(ev, null, 2), "utf8");
  writeFileSync(mdPath, md, "utf8");
  console.log(md);
  console.log(`\nWrote ${jsonPath} and ${mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
