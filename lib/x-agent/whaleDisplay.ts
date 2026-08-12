import {
  getUniqueTraderName,
  isAnonymousWalletAddress,
  isUsableCustomWhaleName,
} from "@/lib/whaleIdentityResolver";
import {
  ANONYMOUS_WHALE_PSEUDONYM,
  formatWalletPseudonym,
  isAnonymousWalletAddress as isRegistryAnonymousWallet,
} from "@/lib/x-agent/whaleRegistryDb";

const UNLABELLED_WHALE_PHRASES = [
  "A high-stakes wallet",
  "A heavy bettor",
  "An unlabelled whale",
] as const;

const PLACEHOLDER_WALLETS = new Set(["unknown", "anonymous", "null", "undefined"]);

function pickUnlabelledWhalePhrase(random: () => number): string {
  const index = Math.floor(random() * UNLABELLED_WHALE_PHRASES.length);
  return (
    UNLABELLED_WHALE_PHRASES[index] ?? UNLABELLED_WHALE_PHRASES[0]
  );
}

function isPlaceholderWallet(walletAddress: string): boolean {
  return PLACEHOLDER_WALLETS.has(walletAddress.trim().toLowerCase());
}

/** True when the registry pseudonym is missing or is a generic placeholder. */
export function isUnlabelledWhalePseudonym(
  walletAddress: string,
  pseudonym?: string | null
): boolean {
  if (!pseudonym?.trim()) return true;
  const trimmed = pseudonym.trim();
  if (trimmed === ANONYMOUS_WHALE_PSEUDONYM) return true;
  if (isRegistryAnonymousWallet(walletAddress) || isAnonymousWalletAddress(walletAddress)) {
    return true;
  }
  if (isPlaceholderWallet(walletAddress)) return true;
  if (!isUsableCustomWhaleName(trimmed, walletAddress)) return true;
  return trimmed === formatWalletPseudonym(walletAddress);
}

/**
 * Human-facing whale label for post copy, tweets, and Telegram.
 * Named registry whales keep their pseudonym; identified wallets without a
 * usable registry alias get a deterministic compact alias (e.g. CrimsonVanguard142).
 */
export function formatWhaleDisplayLabel(
  walletAddress: string,
  pseudonym?: string | null,
  random: () => number = Math.random
): string {
  if (
    isAnonymousWalletAddress(walletAddress) ||
    isPlaceholderWallet(walletAddress)
  ) {
    return pickUnlabelledWhalePhrase(random);
  }

  return getUniqueTraderName({
    wallet: walletAddress,
    pseudonym,
  });
}
