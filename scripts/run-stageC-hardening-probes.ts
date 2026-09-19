#!/usr/bin/env tsx
/**
 * Run three Stage C hardening probes (does NOT resume batch).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const WALLETS = [
  {
    label: "large_checkpoint",
    wallet: "0x821dab0565ebf5b327f51db06223fdcfe01acf16",
  },
  {
    label: "high_log_count",
    wallet: "0x01c78f8873c0c86d6b6b92ff627e3802237ee995",
  },
  {
    label: "deferred_slow",
    wallet: "0x7e5972bfc25819775ee5a9d4f191919375487b8b",
  },
] as const;

const script = join(process.cwd(), "scripts/probe-stageC-hardening.ts");

for (const entry of WALLETS) {
  console.error(`\n[probe-suite] === ${entry.label} ${entry.wallet} ===`);
  const result = spawnSync(
    "npx",
    ["tsx", "--tsconfig", "tsconfig.json", script, "--wallet", entry.wallet],
    {
      env: { ...process.env, AUDIT_PROGRESS: "1" },
      stdio: "inherit",
    }
  );
  if (result.status !== 0) {
    console.error(`[probe-suite] probe failed label=${entry.label} status=${result.status}`);
  }
}
