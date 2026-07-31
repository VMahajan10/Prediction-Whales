import { isAnonymousWalletAddress } from "@/lib/x-agent/whaleRegistryDb";

const WHALE_ADJECTIVES = [
  "Emerald",
  "Crimson",
  "Azure",
  "Golden",
  "Silver",
  "Obsidian",
  "Ivory",
  "Scarlet",
  "Cobalt",
  "Amber",
  "Onyx",
  "Verdant",
  "Solar",
  "Lunar",
  "Iron",
  "Velvet",
] as const;

const WHALE_NOUNS = [
  "Vanguard",
  "Oracle",
  "Nomad",
  "Sentinel",
  "Harbinger",
  "Strategist",
  "Pioneer",
  "Custodian",
  "Navigator",
  "Arbiter",
  "Champion",
  "Specter",
  "Warden",
  "Virtuoso",
  "Corsair",
  "Paragon",
] as const;

export interface WhaleRegistryStats {
  winRate?: number | null;
  resolvedBetsCount?: number | null;
  avgEv?: number | null;
}

export interface ResolvedWhaleIdentity {
  pseudonym: string;
  initials: string;
  winRate: number | null;
  resolvedBetsCount: number | null;
  avgEv: number | null;
  roi: number | null;
}

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

/** FNV-1a hash — deterministic across browser and Node. */
export function hashWalletAddress(wallet: string): number {
  const normalized = normalizeWallet(wallet);
  let hash = 2166136261;

  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export function isHexWalletDisplay(value: string): boolean {
  const trimmed = value.trim();
  if (/^0x[a-fA-F0-9]{4,}$/i.test(trimmed)) return true;
  if (/^0x[a-fA-F0-9]{4,}…[a-fA-F0-9]{4,}$/i.test(trimmed)) return true;
  return false;
}

function isRegistryHexPseudonym(
  customName: string,
  walletAddress: string
): boolean {
  const normalized = normalizeWallet(walletAddress);
  const custom = customName.trim().toLowerCase();
  if (custom === normalized) return true;
  if (isHexWalletDisplay(customName)) return true;
  if (custom === `${normalized.slice(0, 6)}…${normalized.slice(-4)}`) return true;
  return false;
}

export function isUsableCustomWhaleName(
  customName: string | null | undefined,
  walletAddress: string
): boolean {
  if (!customName?.trim()) return false;
  if (isRegistryHexPseudonym(customName, walletAddress)) return false;
  return !isHexWalletDisplay(customName);
}

export function generateDeterministicWhalePseudonym(walletAddress: string): string {
  const hash = hashWalletAddress(walletAddress);
  const adjective = WHALE_ADJECTIVES[hash % WHALE_ADJECTIVES.length];
  const noun =
    WHALE_NOUNS[Math.floor(hash / WHALE_ADJECTIVES.length) % WHALE_NOUNS.length];
  const serial = (hash % 900) + 100;
  return `${adjective} ${noun} #${serial}`;
}

export function whaleInitialsFromPseudonym(pseudonym: string): string {
  const words = pseudonym
    .replace(/#\d+/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
  }

  const compact = pseudonym.replace(/[^a-zA-Z]/g, "");
  return (compact.slice(0, 2) || "WH").toUpperCase();
}

/** UI-safe label — never returns a raw hex wallet fragment. */
export function sanitizeWhaleDisplayName(
  value: string | null | undefined,
  walletAddress: string
): string {
  if (!value?.trim() || isHexWalletDisplay(value)) {
    return generateDeterministicWhalePseudonym(walletAddress);
  }
  if (isRegistryHexPseudonym(value, walletAddress)) {
    return generateDeterministicWhalePseudonym(walletAddress);
  }
  return value.trim();
}

export function formatWhaleSignedPercent(
  decimal: number | null | undefined,
  digits = 1
): string {
  if (decimal == null || !Number.isFinite(decimal)) return "—";
  const pct = decimal <= 1 && decimal >= -1 ? decimal * 100 : decimal;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(digits)}%`;
}

export function formatWhaleWinRatePercent(
  winRate: number | null | undefined
): string {
  if (winRate == null || !Number.isFinite(winRate)) return "—";
  const pct = winRate <= 1 ? winRate * 100 : winRate;
  return `${Math.round(pct)}%`;
}

/**
 * Resolve a stable whale identity for feed cards and registry-backed stats.
 * Uses registry `customName` when present; otherwise a deterministic pseudonym.
 */
export function resolveWhaleIdentity(
  walletAddress: string | null | undefined,
  customName?: string | null,
  stats?: WhaleRegistryStats | null
): ResolvedWhaleIdentity {
  if (!walletAddress || isAnonymousWalletAddress(walletAddress)) {
    return {
      pseudonym: "Anonymous Observer",
      initials: "AO",
      winRate: null,
      resolvedBetsCount: null,
      avgEv: null,
      roi: null,
    };
  }

  const normalized = normalizeWallet(walletAddress);
  const pseudonym = isUsableCustomWhaleName(customName, normalized)
    ? customName!.trim()
    : generateDeterministicWhalePseudonym(normalized);

  const avgEv =
    stats?.avgEv != null && Number.isFinite(stats.avgEv) ? stats.avgEv : null;
  const roi = avgEv;

  return {
    pseudonym: sanitizeWhaleDisplayName(pseudonym, normalized),
    initials: whaleInitialsFromPseudonym(pseudonym),
    winRate:
      stats?.winRate != null && Number.isFinite(stats.winRate)
        ? stats.winRate
        : null,
    resolvedBetsCount:
      stats?.resolvedBetsCount != null &&
      Number.isFinite(stats.resolvedBetsCount)
        ? stats.resolvedBetsCount
        : null,
    avgEv,
    roi,
  };
}
