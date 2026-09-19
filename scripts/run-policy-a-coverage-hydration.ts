#!/usr/bin/env tsx
/**
 * Bounded indexed-history hydration for production-relevant wallets.
 * Does not change feed admission or production gates.
 */
import "./preload-env";
import { isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { runBoundedProductionWalletHydration } from "@/lib/walletLedger/indexed/shadow/productionWalletHydration";

const ACTIVE_WALLETS = [
  "0x5268527977f700f9bf9b6d5cd843859e4e70135d",
  "0xfe787d2da716d60e8acff57fb87eb13cd4d10319",
];

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const onlyActive = process.argv.includes("--active-feed-wallets-only");
  const maxWallets = Number(
    process.argv.find((arg) => arg.startsWith("--max-wallets="))?.split("=")[1] ??
      "2"
  );

  const result = await runBoundedProductionWalletHydration({
    maxWallets,
    wallets: onlyActive ? ACTIVE_WALLETS : undefined,
  });

  console.log(
    JSON.stringify(
      {
        mode: "policy_a_coverage_hydration",
        onlyActiveFeedWallets: onlyActive,
        maxWallets,
        ...result,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[run-policy-a-coverage-hydration] failed:", error);
  process.exit(1);
});
