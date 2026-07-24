import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";

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
  const address = normalizeWalletAddress(wallet);
  if (!address || !isPrismaEnabled()) return null;

  const prisma = getPrisma();
  if (!prisma) return null;

  return prisma.whaleRegistry.findUnique({
    where: { walletAddress: address },
  });
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
        ...(input.avgStakeNotional != null
          ? { avgStakeNotional: input.avgStakeNotional }
          : {}),
        ...(input.avgEv != null ? { avgEv: input.avgEv } : {}),
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
  });

  if (!whale) return null;
  return { whale, created: true };
}
