#!/usr/bin/env tsx
import "../tests/preload-env";
import {
  auditCanonicalDuplicates,
  backfillCanonicalIdentityForWallet,
  collapseCanonicalDuplicatesForWallet,
  postCollapseGateReport,
} from "@/lib/walletLedger/indexed/store/canonicalWalletCollapse";
import { countWalletLedgerEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";

const WALLET = "0x0562e01b3c3e65bb93bf0de32f02cec238a79d66";

async function main(): Promise<void> {
  const before = await countWalletLedgerEvents(WALLET);
  const auditBefore = await auditCanonicalDuplicates(WALLET);
  await backfillCanonicalIdentityForWallet(WALLET);
  const collapse = await collapseCanonicalDuplicatesForWallet(WALLET);
  const after = await countWalletLedgerEvents(WALLET);
  const gate = await postCollapseGateReport(WALLET);
  const auditAfter = await auditCanonicalDuplicates(WALLET);
  console.log(
    JSON.stringify(
      { before, after, auditBefore, collapse, gate, auditAfter },
      null,
      2
    )
  );
}

void main();
