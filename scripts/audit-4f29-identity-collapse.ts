#!/usr/bin/env tsx
/**
 * Read-only identity collapse audit for 4f29 using existing snapshot data.
 */
import "../tests/preload-env";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AUTHORITATIVE_COVERAGE_FINGERPRINT_VERSION,
  buildAuthoritativeCoverageFingerprint,
} from "@/lib/walletLedger/indexed/store/authoritativeCoverageFingerprint";
import {
  countUniqueLegacyVsCanonicalIdentities,
  dedupeKeyHasTimestampZero,
  hashCanonicalAuthoritativeIdentities,
} from "@/lib/walletLedger/canonicalChainIdentity";
import { backfillAuthoritativeLogIndexFromLookup } from "@/lib/walletLedger/indexed/store/logIndexTaxonomy";
import type { WalletValidationSnapshot } from "@/lib/walletLedger/indexed/store/validationSnapshot";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

const WALLET = "0x4f29e103339919c4baaea2a60195cf1c8bb27a7e";
const SNAPSHOT =
  ".cache/wallet-validation-snapshots/0x4f29e103339919c4baaea2a60195cf1c8bb27a7e-0x4f29e103339919c4baaea2a60195cf1c8bb27a7e-mu0gw8uj.json";

async function main() {
  const raw = await readFile(path.join(process.cwd(), SNAPSHOT), "utf8");
  const snapshot = JSON.parse(raw) as WalletValidationSnapshot;
  const authoritative = snapshot.authoritativeEvents as WalletLedgerEvent[];

  const beforeBackfill = countUniqueLegacyVsCanonicalIdentities(authoritative);
  const backfilled = backfillAuthoritativeLogIndexFromLookup(authoritative);
  const afterBackfill = countUniqueLegacyVsCanonicalIdentities(backfilled.events);

  const fingerprintBefore = buildAuthoritativeCoverageFingerprint({
    wallet: WALLET,
    provider: "etherscan_v2",
    perContractFromBlock: {},
    throughBlock: 0,
    querySubjects: [WALLET],
    authoritativeEvents: authoritative,
  });
  const fingerprintAfter = buildAuthoritativeCoverageFingerprint({
    wallet: WALLET,
    provider: "etherscan_v2",
    perContractFromBlock: {},
    throughBlock: 0,
    querySubjects: [WALLET],
    authoritativeEvents: backfilled.events,
  });

  const timestampDuplicateSamples = beforeBackfill.groups
    .filter((group) => group.timestamps.some((ts) => ts <= 0) && group.timestamps.some((ts) => ts > 0))
    .slice(0, 10)
    .map((group) => ({
      canonicalIdentity: group.canonicalIdentity,
      legacyDedupeKeys: group.legacyDedupeKeys,
      timestamps: group.timestamps,
      ledgerFieldConflicts: group.ledgerFieldConflicts,
      hasTimestampZeroKey: group.legacyDedupeKeys.some(dedupeKeyHasTimestampZero),
    }));

  const conflictSamples = beforeBackfill.groups
    .filter((group) => group.ledgerFieldConflicts.length > 0)
    .slice(0, 10);

  console.log(
    JSON.stringify(
      {
        mode: "4f29_identity_collapse_audit",
        wallet: WALLET,
        snapshotPath: SNAPSHOT,
        legacyAuthoritativeIdentityCount: beforeBackfill.legacyIdentityCount,
        canonicalChainIdentityCount: beforeBackfill.canonicalIdentityCount,
        collapsedPhysicalLogs: beforeBackfill.collapsedPhysicalLogs,
        collapsedDuplicateGroups: beforeBackfill.collapsedDuplicateGroups,
        timestampZeroVsValidGroups: beforeBackfill.timestampZeroVsValidGroups,
        ledgerFieldConflictGroups: beforeBackfill.ledgerFieldConflictGroups,
        unresolvedWithoutCanonicalIdentity: beforeBackfill.unresolvedCount,
        canonicalIdentityHash: hashCanonicalAuthoritativeIdentities(authoritative),
        afterLogIndexCoordinateBackfill: {
          canonicalIdentityCount: afterBackfill.canonicalIdentityCount,
          collapsedPhysicalLogs: afterBackfill.collapsedPhysicalLogs,
          unresolvedCount: afterBackfill.unresolvedCount,
        },
        fingerprintStability: {
          fingerprintVersion: AUTHORITATIVE_COVERAGE_FINGERPRINT_VERSION,
          beforeBackfill: fingerprintBefore.authoritativeIdentityHash,
          afterBackfill: fingerprintAfter.authoritativeIdentityHash,
          unchanged:
            fingerprintBefore.authoritativeIdentityHash ===
            fingerprintAfter.authoritativeIdentityHash,
        },
        timestampDuplicateSamples,
        ledgerFieldConflictSamples: conflictSamples,
        interpretation:
          beforeBackfill.legacyIdentityCount > beforeBackfill.canonicalIdentityCount
            ? "legacy timestamp-bearing dedupe keys inflated authoritative identity count"
            : "legacy and canonical counts align for available coordinates",
        is195304Canonical:
          beforeBackfill.ledgerFieldConflictGroups === 0 &&
          beforeBackfill.canonicalIdentityCount <= beforeBackfill.legacyIdentityCount,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[audit-4f29-identity-collapse] failed:", error);
  process.exit(1);
});
