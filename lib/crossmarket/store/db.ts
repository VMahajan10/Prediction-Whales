import "server-only";

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

function createDb(connectionString: string) {
  const client = neon(connectionString);
  return drizzle(client, { schema });
}

type Database = ReturnType<typeof createDb>;

let db: Database | null = null;

export function isDatabaseEnabled(): boolean {
  return !!process.env.DATABASE_URL;
}

/**
 * Neon HTTP driver — no TCP pool; safe for Vercel serverless cold starts.
 */
export function getDb(): Database {
  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (!db) {
    db = createDb(process.env.DATABASE_URL!);
  }
  return db;
}

export type { Database };
