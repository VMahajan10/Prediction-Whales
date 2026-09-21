#!/usr/bin/env tsx
/**
 * Archive pre-resolver-fix shadow window and start a new observation epoch.
 * Does not modify feed_trades.
 */
import "../tests/preload-env";
import { buildProductionWalletCohort } from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import {
  beginPostResolverFixShadowEpoch,
  POLICY_A_ATTRIBUTION_RESOLVER_VERSION,
} from "@/lib/walletLedger/indexed/shadow/policyAShadowValidation";

async function main(): Promise<void> {
  const cohort = await buildProductionWalletCohort({ lookbackDays: 30 });
  const state = beginPostResolverFixShadowEpoch(cohort.wallets);
  console.log(
    JSON.stringify(
      {
        mode: "policy_a_shadow_resolver_epoch",
        attributionResolverVersion: POLICY_A_ATTRIBUTION_RESOLVER_VERSION,
        newStartedAt: state.startedAt,
        supersededObservation: state.supersededObservation ?? null,
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
