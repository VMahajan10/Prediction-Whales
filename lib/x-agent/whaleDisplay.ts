import {
  ANONYMOUS_WHALE_PSEUDONYM,
  formatWalletPseudonym,
  isAnonymousWalletAddress,
} from "@/lib/x-agent/whaleRegistryDb";

const UNLABELLED_WHALE_PHRASES = [
  "A high-stakes wallet",
  "A heavy bettor",
  "An unlabelled whale",
] as const;

function pickUnlabelledWhalePhrase(random: () => number): string {
  const index = Math.floor(random() * UNLABELLED_WHALE_PHRASES.length);
  return (
    UNLABELLED_WHALE_PHRASES[index] ?? UNLABELLED_WHALE_PHRASES[0]
  );
}

/** True when the registry pseudonym is missing or is a generic placeholder. */
export function isUnlabelledWhalePseudonym(
  walletAddress: string,
  pseudonym?: string | null
): boolean {
  if (!pseudonym?.trim()) return true;
  const trimmed = pseudonym.trim();
  if (trimmed === ANONYMOUS_WHALE_PSEUDONYM) return true;
  if (isAnonymousWalletAddress(walletAddress)) return true;
  return trimmed === formatWalletPseudonym(walletAddress);
}

/**
 * Human-facing whale label for post copy.
 * Named registry whales keep their pseudonym; anonymous/unlabelled wallets
 * use rotating natural phrases (never "Anonymous Whale").
 */
export function formatWhaleDisplayLabel(
  walletAddress: string,
  pseudonym?: string | null,
  random: () => number = Math.random
): string {
  if (isUnlabelledWhalePseudonym(walletAddress, pseudonym)) {
    return pickUnlabelledWhalePhrase(random);
  }
  return pseudonym!.trim();
}
