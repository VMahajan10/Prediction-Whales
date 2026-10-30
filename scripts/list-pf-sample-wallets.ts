#!/usr/bin/env tsx
import "../tests/preload-env";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";

async function main() {
  if (!isPrismaEnabled()) return;
  const prisma = getPrisma();
  if (!prisma) return;
  const rows = await prisma.whaleRegistry.findMany({
    where: { hydrationStatus: "complete" },
    select: { walletAddress: true },
    take: 300,
  });
  const pool = rows.map((r) => r.walletAddress.toLowerCase());
  const picked: string[] = [];
  const seed = Number(process.env.VALIDATE_PF_SEED ?? "42");
  let rng = seed;
  const rand = () => {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    return rng / 0x100000000;
  };
  while (picked.length < 20 && pool.length > 0) {
    const i = Math.floor(rand() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  console.log(picked.join("\n"));
}

main();
