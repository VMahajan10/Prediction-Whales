import dotenv from "dotenv";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

// Load environment variables from .env.local
dotenv.config({ path: ".env.local" });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Fallback check if property exists on prisma instance
  const whaleClient =
    (prisma as any).whaleRegistry || (prisma as any).WhaleRegistry;

  if (!whaleClient) {
    console.error("Available models on prisma client:", Object.keys(prisma));
    throw new Error(
      "whaleRegistry model was not found on PrismaClient instance. Did you run npx prisma generate after adding model WhaleRegistry?"
    );
  }

  await whaleClient.upsert({
    where: { walletAddress: "0x1111111111111111111111111111111111111111" },
    update: {},
    create: {
      walletAddress: "0x1111111111111111111111111111111111111111",
      pseudonym: "The French Whale",
      resolvedBetsCount: 1240,
      avgEv: 0.12,
      winRate: 0.68,
      avgStakeNotional: 8000,
    },
  });

  console.log("✅ Seeded test whale registry!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
