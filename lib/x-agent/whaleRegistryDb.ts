import "server-only";

import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  ANONYMOUS_WALLET_ADDRESS,
  isAnonymousWalletAddress,
} from "@/lib/whaleIdentityResolver";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";

export { ANONYMOUS_WALLET_ADDRESS, isAnonymousWalletAddress };

export const ANONYMOUS_WHALE_PSEUDONYM = "Anonymous Whale";

export function normalizeWalletAddress(wallet: string): string {
  return wallet.trim().toLowerCase();
}

export function formatWalletPseudonym(wallet: string): string {
  const normalized = normalizeWalletAddress(wallet);
  if (normalized.length < 12) return normalized;
  return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`;
}

export async function findWhaleByWallet(
  wallet: string
): Promise<WhaleRegistry | null> {
  return findWhaleByWalletCaseInsensitive(wallet);
}

/** Case-insensitive wallet lookup (normalized + LOWER() fallback). */
export async function findWhaleByWalletCaseInsensitive(
  wallet: string
): Promise<WhaleRegistry | null> {
  const address = normalizeWalletAddress(wallet);
  if (!address || !isPrismaEnabled()) return null;

  const prisma = getPrisma();
  if (!prisma) return null;

  const direct = await prisma.whaleRegistry.findUnique({
    where: { walletAddress: address },
  });
  if (direct) return direct;

  const rows = await prisma.$queryRaw<WhaleRegistry[]>`
    SELECT
      wallet_address AS "walletAddress",
      pseudonym,
      resolved_bets_count AS "resolvedBetsCount",
      avg_ev AS "avgEv",
      win_rate AS "winRate",
      avg_stake_notional AS "avgStakeNotional",
      posted_count_30d AS "postedCount30d",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM whale_registry
    WHERE LOWER(wallet_address) = ${address}
    LIMIT 1
  `;

  return rows[0] ?? null;
}

export async function upsertWhaleRegistry(input: {
  walletAddress: string;
  pseudonym?: string;
  resolvedBetsCount?: number;
  avgEv?: number;
  winRate?: number;
  avgStakeNotional?: number;
}): Promise<WhaleRegistry | null> {
  const address = normalizeWalletAddress(input.walletAddress);
  if (!address || !isPrismaEnabled()) return null;

  const prisma = getPrisma();
  if (!prisma) return null;

  try {
    return await prisma.whaleRegistry.upsert({
      where: { walletAddress: address },
      update: {
        ...(input.resolvedBetsCount != null
          ? { resolvedBetsCount: input.resolvedBetsCount }
          : {}),
        ...(input.avgStakeNotional != null
          ? { avgStakeNotional: input.avgStakeNotional }
          : {}),
        ...(input.avgEv != null ? { avgEv: input.avgEv } : {}),
        ...(input.winRate != null ? { winRate: input.winRate } : {}),
      },
      create: {
        walletAddress: address,
        pseudonym: input.pseudonym ?? formatWalletPseudonym(address),
        resolvedBetsCount: input.resolvedBetsCount ?? 0,
        avgEv: input.avgEv ?? 0,
        winRate: input.winRate ?? 0,
        avgStakeNotional: input.avgStakeNotional ?? 0,
        postedCount30d: 0,
      },
    });
  } catch (error) {
    console.error("[DB WRITE ERROR]", error);
    throw error;
  }
}

export async function ensureWhaleInRegistry(
  walletAddress: string,
  hints?: {
    pseudonym?: string;
    avgEv?: number;
    avgStakeNotional?: number;
    resolvedBetsCount?: number;
    winRate?: number;
  }
): Promise<{ whale: WhaleRegistry; created: boolean } | null> {
  const existing = await findWhaleByWallet(walletAddress);
  if (existing) {
    return { whale: existing, created: false };
  }

  const whale = await upsertWhaleRegistry({
    walletAddress,
    pseudonym: hints?.pseudonym,
    avgEv: hints?.avgEv,
    avgStakeNotional: hints?.avgStakeNotional,
    resolvedBetsCount: hints?.resolvedBetsCount,
    winRate: hints?.winRate,
  });

  if (!whale) return null;
  return { whale, created: true };
}
