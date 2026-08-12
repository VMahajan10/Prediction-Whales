export const ANONYMOUS_WALLET_ADDRESS =
  "0x0000000000000000000000000000000000000000";

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

import { resolveWalletClvScore } from "@/lib/metrics/clv";
import { WHALE_TRADER_FALLBACK_ALIAS } from "@/lib/trades/whaleAliasConstants";

export { WHALE_TRADER_FALLBACK_ALIAS } from "@/lib/trades/whaleAliasConstants";

export interface WhaleRegistryStats {
  winRate?: number | null;
  resolvedBetsCount?: number | null;
  avgEv?: number | null;
  roi?: number | null;
  clvScore?: number | null;
}

export interface ResolvedWhaleIdentity {
  pseudonym: string;
  initials: string;
  winRate: number | null;
  resolvedBetsCount: number | null;
  avgEv: number | null;
  roi: number | null;
  clvScore?: number;
}

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

/** Live-feed trades with no resolved proxy wallet (null, empty, or zero address). */
export function isAnonymousWalletAddress(
  wallet: string | null | undefined
): boolean {
  if (wallet == null) return true;
  const normalized = normalizeWallet(wallet);
  return !normalized || normalized === ANONYMOUS_WALLET_ADDRESS;
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
  return generateUniqueTraderName(walletAddress);
}

/** Compact deterministic alias: `CrimsonVanguard142` (Adjective+Noun+Number). */
export function generateUniqueTraderName(walletAddress: string): string {
  const normalized = normalizeWallet(walletAddress);
  if (
    !normalized ||
    isAnonymousWalletAddress(normalized) ||
    normalized === "unknown" ||
    normalized === "anonymous"
  ) {
    return "AnonymousTrader102";
  }

  const hash = hashWalletAddress(normalized);
  const adjective = WHALE_ADJECTIVES[hash % WHALE_ADJECTIVES.length];
  const noun =
    WHALE_NOUNS[Math.floor(hash / WHALE_ADJECTIVES.length) % WHALE_NOUNS.length];
  const serial = (hash % 900) + 100;
  return `${adjective}${noun}${serial}`;
}

export const UNIQUE_TRADER_NAME_PATTERN = /^[A-Z][a-z]+[A-Z][a-z]+\d{3}$/;

export function isLegacySpacedWhalePseudonym(value: string): boolean {
  return /^[A-Za-z]+ [A-Za-z]+ #\d{3}$/.test(value.trim());
}

export type UniqueTraderNameInput = {
  wallet?: string | null;
  proxyWallet?: string | null;
  username?: string | null;
  pseudonym?: string | null;
  whaleAlias?: string | null;
  name?: string | null;
};

function resolveTraderWallet(
  trader: UniqueTraderNameInput
): string | undefined {
  const wallet = (trader.proxyWallet ?? trader.wallet)?.trim().toLowerCase();
  if (!wallet || isAnonymousWalletAddress(wallet)) return undefined;
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) return undefined;
  return wallet;
}

/**
 * Stable trader label for feed cards, tweets, and Telegram copy.
 * Custom registry names win; unnamed wallets get a deterministic compact alias.
 */
export function getUniqueTraderName(trader: UniqueTraderNameInput): string {
  const wallet = resolveTraderWallet(trader);
  const candidates = [
    trader.username,
    trader.whaleAlias,
    trader.pseudonym,
    trader.name,
  ];

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    if (wallet) {
      if (!isUsableCustomWhaleName(trimmed, wallet)) continue;
    } else if (isHexWalletDisplay(trimmed)) {
      continue;
    }
    return trimmed;
  }

  if (wallet) {
    return generateUniqueTraderName(wallet);
  }

  return WHALE_TRADER_FALLBACK_ALIAS;
}

export function whaleInitialsFromPseudonym(pseudonym: string): string {
  const withoutSerial = pseudonym.replace(/\d+$/, "").trim();
  const pascalParts = withoutSerial.match(/[A-Z][a-z]+/g);
  if (pascalParts && pascalParts.length >= 2) {
    return `${pascalParts[0]![0] ?? ""}${pascalParts[1]![0] ?? ""}`.toUpperCase();
  }

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

/** Compact `0x1234…5678` label for wallets without a registry pseudonym. */
export function formatShortWalletAddress(wallet: string): string {
  const normalized = normalizeWallet(wallet);
  if (normalized.length < 12) return normalized;
  return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`;
}

/**
 * Feed/card trader label — delegates to {@link getUniqueTraderName}.
 */
export function resolveFeedTraderDisplayName(
  input: UniqueTraderNameInput
): string {
  return getUniqueTraderName(input);
}

/** UI-safe label — never returns a raw hex wallet fragment. */
export function sanitizeWhaleDisplayName(
  value: string | null | undefined,
  walletAddress: string
): string {
  if (!value?.trim() || isHexWalletDisplay(value)) {
    return generateUniqueTraderName(walletAddress);
  }
  if (isRegistryHexPseudonym(value, walletAddress)) {
    return generateUniqueTraderName(walletAddress);
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
    : generateUniqueTraderName(normalized);

  const avgEv =
    stats?.avgEv != null && Number.isFinite(stats.avgEv) ? stats.avgEv : null;
  const roi =
    stats?.roi != null && Number.isFinite(stats.roi)
      ? stats.roi
      : avgEv;
  const clvScore =
    stats?.clvScore != null && Number.isFinite(stats.clvScore)
      ? stats.clvScore
      : resolveWalletClvScore({ roi, avgEv }) ?? undefined;

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
    ...(clvScore != null ? { clvScore } : {}),
  };
}
