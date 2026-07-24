import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaPool?: Pool;
};

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
  }

  const pool = globalForPrisma.prismaPool ?? new Pool({ connectionString });
  globalForPrisma.prismaPool = pool;

  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export function isPrismaEnabled(): boolean {
  return !!process.env.DATABASE_URL?.trim();
}

/** Shared Prisma 7 client (pg driver adapter). */
export function getPrisma(): PrismaClient | null {
  if (!isPrismaEnabled()) return null;

  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }

  return globalForPrisma.prisma;
}

/** Close Prisma client and underlying pg pool (for scripts / CI). */
export async function disconnectPrisma(): Promise<void> {
  if (globalForPrisma.prisma) {
    await globalForPrisma.prisma.$disconnect();
    globalForPrisma.prisma = undefined;
  }

  if (globalForPrisma.prismaPool) {
    await globalForPrisma.prismaPool.end();
    globalForPrisma.prismaPool = undefined;
  }
}
