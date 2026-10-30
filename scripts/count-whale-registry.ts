#!/usr/bin/env tsx
import "../tests/preload-env";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";

async function main() {
  if (!isPrismaEnabled()) return;
  const prisma = getPrisma();
  if (!prisma) return;
  const n = await prisma.whaleRegistry.count();
  console.log(n);
}

main();
