import "server-only";

import {
  generateUniqueTraderName,
  isAnonymousWalletAddress,
  isUsableCustomWhaleName,
} from "@/lib/whaleIdentityResolver";
import {
  findWhaleByWallet,
  formatWalletPseudonym,
  normalizeWalletAddress,
  upsertWhaleRegistry,
} from "@/lib/x-agent/whaleRegistryDb";

const PLACEHOLDER_WALLETS = new Set(["unknown", "anonymous", "null", "undefined"]);

/** True when a registry pseudonym should be replaced with a generated alias. */
export function needsGeneratedWhalePseudonym(
  walletAddress: string,
  pseudonym?: string | null
): boolean {
  if (!pseudonym?.trim()) return true;
  if (!isUsableCustomWhaleName(pseudonym, walletAddress)) return true;
  return pseudonym.trim() === formatWalletPseudonym(walletAddress);
}

function isResolvableWallet(walletAddress: string): boolean {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized || isAnonymousWalletAddress(normalized)) return false;
  if (PLACEHOLDER_WALLETS.has(normalized)) return false;
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return false;
  return true;
}

/**
 * Resolve a stable whale alias for post copy and review UI.
 * Checks whale_registry first, then generates a deterministic pseudonym from
 * the wallet hash and persists it so future trades reuse the same alias.
 */
export async function getWhaleAlias(walletAddress: string): Promise<string | null> {
  if (!isResolvableWallet(walletAddress)) {
    return null;
  }

  const normalized = normalizeWalletAddress(walletAddress);
  const existing = await findWhaleByWallet(normalized);

  if (existing && !needsGeneratedWhalePseudonym(normalized, existing.pseudonym)) {
    return existing.pseudonym.trim();
  }

  const pseudonym = generateUniqueTraderName(normalized);
  const whale = await upsertWhaleRegistry({
    walletAddress: normalized,
    pseudonym,
    resolvedBetsCount: existing?.resolvedBetsCount,
    avgEv: existing?.avgEv,
    winRate: existing?.winRate,
    avgStakeNotional: existing?.avgStakeNotional,
  });

  return whale?.pseudonym?.trim() ?? pseudonym;
}
