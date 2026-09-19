import { createHash } from "node:crypto";
import { QUERY_PLAN_VERSION } from "@/lib/walletLedger/indexed/checkpoint";
import {
  filterChainAuthoritativeEvents,
  hashAuthoritativeEventIdentities,
} from "@/lib/walletLedger/indexed/store/authoritativePersistence";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export const AUTHORITATIVE_COVERAGE_FINGERPRINT_VERSION = "canonical-v2";

export interface AuthoritativeCoverageFingerprint {
  fingerprintVersion: string;
  wallet: string;
  provider: string;
  chainId: string;
  queryPlanVersion: string;
  perContractFromBlock: Record<string, number>;
  throughBlock: number;
  querySubjects: string[];
  eventIdentityCount: number;
  authoritativeIdentityHash: string;
  fingerprintHash: string;
}

export interface BuildAuthoritativeCoverageFingerprintInput {
  wallet: string;
  provider: string;
  chainId?: string;
  queryPlanVersion?: string;
  perContractFromBlock: Record<string, number>;
  throughBlock: number;
  querySubjects: string[];
  authoritativeEvents: WalletLedgerEvent[];
}

function stableRecordEntries(
  record: Record<string, number>
): Array<[string, number]> {
  return Object.entries(record).sort(([left], [right]) =>
    left.localeCompare(right)
  );
}

export function buildAuthoritativeCoverageFingerprint(
  input: BuildAuthoritativeCoverageFingerprintInput
): AuthoritativeCoverageFingerprint {
  const authoritative = filterChainAuthoritativeEvents(input.authoritativeEvents);
  const authoritativeIdentityHash =
    hashAuthoritativeEventIdentities(authoritative);
  const payload = {
    fingerprintVersion: AUTHORITATIVE_COVERAGE_FINGERPRINT_VERSION,
    wallet: input.wallet.toLowerCase(),
    provider: input.provider,
    chainId: input.chainId ?? "137",
    queryPlanVersion: input.queryPlanVersion ?? QUERY_PLAN_VERSION,
    perContractFromBlock: stableRecordEntries(input.perContractFromBlock),
    throughBlock: input.throughBlock,
    querySubjects: [...input.querySubjects].map((s) => s.toLowerCase()).sort(),
    eventIdentityCount: authoritative.length,
    authoritativeIdentityHash,
  };
  const fingerprintHash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");

  return {
    fingerprintVersion: payload.fingerprintVersion,
    wallet: payload.wallet,
    provider: payload.provider,
    chainId: payload.chainId,
    queryPlanVersion: payload.queryPlanVersion,
    perContractFromBlock: Object.fromEntries(payload.perContractFromBlock),
    throughBlock: payload.throughBlock,
    querySubjects: payload.querySubjects,
    eventIdentityCount: payload.eventIdentityCount,
    authoritativeIdentityHash,
    fingerprintHash,
  };
}

export function fingerprintsMateriallyMatch(
  left: AuthoritativeCoverageFingerprint | null | undefined,
  right: AuthoritativeCoverageFingerprint | null | undefined
): boolean {
  if (!left || !right) return false;
  return left.fingerprintHash === right.fingerprintHash;
}

export function assessBaselineCompletenessAgainstFingerprint(input: {
  baselineComplete: boolean;
  storedFingerprint: AuthoritativeCoverageFingerprint | null;
  currentFingerprint: AuthoritativeCoverageFingerprint;
}): {
  baselineComplete: boolean;
  fingerprintMatch: boolean;
  reason: string;
} {
  const fingerprintMatch = fingerprintsMateriallyMatch(
    input.storedFingerprint,
    input.currentFingerprint
  );
  if (!input.baselineComplete) {
    return {
      baselineComplete: false,
      fingerprintMatch,
      reason: "authoritative identities missing from wallet_ledger_events",
    };
  }
  if (!fingerprintMatch) {
    return {
      baselineComplete: false,
      fingerprintMatch: false,
      reason:
        "stored baseline fingerprint differs from current authoritative reconstruction fingerprint",
    };
  }
  return {
    baselineComplete: true,
    fingerprintMatch: true,
    reason:
      "all authoritative identities present and coverage fingerprint matches",
  };
}
