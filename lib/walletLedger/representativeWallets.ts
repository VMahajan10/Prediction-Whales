export interface RepresentativeWalletSpec {
  label: string;
  wallet: string;
  transactionHash?: string;
  assetId?: string;
  category: string;
}

/** Default batch for Phase 2A validation (full addresses from prior diagnostics). */
export const REPRESENTATIVE_WALLET_SPECS: RepresentativeWalletSpec[] = [
  {
    label: "legacy50_with_stake",
    wallet: "0xde7be6d489bce070a959e0cb813128ae659b5f4b",
    category: "legacy_resolved_50",
  },
  {
    label: "high_avg_ev_truncated",
    wallet: "0x7e5972bfc25819775ee5a9d4f191919375487b8b",
    category: "activity_trade_ceiling",
  },
  {
    label: "buy_sell_active",
    wallet: "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66",
    category: "buy_sell_reconciliation",
  },
  {
    label: "buy_sell_active_2",
    wallet: "0x1ff3d3fdef2558f3eb4aabdd7011a0245df8eb39",
    category: "buy_sell",
  },
  {
    label: "recently_hydrated_runtime",
    wallet: "0xc2e5359b204c4296b7e1a07603fe0b657486b3a5",
    category: "recent_hydration",
  },
  {
    label: "low_volume_recent",
    wallet: "0xafcdc656e51db18616bdb2e8737c100363714072",
    category: "low_volume",
  },
  {
    label: "many_buys_whale",
    wallet: "0x0afa7be11ff4e36567d8ada047853122e399eff3",
    category: "many_buys",
  },
  {
    label: "legacy50_high_ev",
    wallet: "0xdc41c39b95453c943174f369926018f6963bdd7e",
    category: "legacy_resolved_50",
  },
  {
    label: "truncation_candidate",
    wallet: "0x01e6e3c5cfe50943e7721398054cb1e22032e7e0",
    category: "activity_trade_ceiling",
  },
  {
    label: "identity_mismatch_probe",
    wallet: "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",
    transactionHash:
      "0x59c3aad53bf226ee382efb4b33bbaa4b43563d4298450011e06c9837e891232a",
    category: "proxy_history_mismatch",
  },
];
