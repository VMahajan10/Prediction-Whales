import { REPRESENTATIVE_WALLET_SPECS } from "@/lib/walletLedger/representativeWallets";

export interface ShadowCohortWallet {
  label: string;
  wallet: string;
  transactionHash?: string;
  cohortReason: string;
  stratum: string;
}

/** Stage A: 10-wallet representative smoke cohort (stratified, not random). */
export const SMOKE_COHORT_10: ShadowCohortWallet[] =
  REPRESENTATIVE_WALLET_SPECS.map((spec) => ({
    label: spec.label,
    wallet: spec.wallet.toLowerCase(),
    transactionHash: spec.transactionHash,
    cohortReason: spec.category,
    stratum: spec.category,
  }));

export function selectShadowCohort(stage: "smoke10" | "full50" = "smoke10"): ShadowCohortWallet[] {
  if (stage === "smoke10") return SMOKE_COHORT_10;
  throw new Error("selectShadowCohort(full50) requires async buildFull50Cohort()");
}
