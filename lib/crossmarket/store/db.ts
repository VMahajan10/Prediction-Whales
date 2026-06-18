import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

let sql: ReturnType<typeof neon> | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function isDatabaseEnabled(): boolean {
  return !!process.env.DATABASE_URL;
}

/**
 * Neon HTTP driver — no TCP pool; safe for Vercel serverless cold starts.
 */
export function getDb() {
  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (!db) {
    sql = neon(process.env.DATABASE_URL!);
    db = drizzle(sql, { schema });
  }
  return db;
}

export type Database = ReturnType<typeof getDb>;
