/**
 * Loaded before any worker/app modules so process.env is populated locally.
 * Keep this file free of imports from lib/* or queue/email code.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();

for (const file of [".env", ".env.local"]) {
  const path = join(cwd, file);
  if (existsSync(path)) {
    loadDotenv({ path, override: file === ".env.local" });
  }
}
