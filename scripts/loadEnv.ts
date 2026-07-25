import { existsSync, readFileSync } from "fs";
import { join } from "path";

function isCiEnvironment(): boolean {
  return process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
}

function isCloudWorkerEnvironment(): boolean {
  return (
    process.env.CLOUD_WORKER === "1" ||
    Boolean(process.env.RAILWAY_ENVIRONMENT) ||
    Boolean(process.env.RENDER) ||
    Boolean(process.env.FLY_APP_NAME) ||
    Boolean(process.env.VERCEL) ||
    process.env.NODE_ENV === "production"
  );
}

/**
 * Load `.env` then `.env.local` for local/script runs.
 * Skips file loading in CI and typical cloud worker hosts where `process.env`
 * is already populated by the platform. Never overwrites variables already
 * set in the environment (`override: false` semantics).
 */
export function loadEnvFiles(): void {
  if (isCiEnvironment() || isCloudWorkerEnvironment()) return;

  for (const file of [".env", ".env.local"]) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || m[1] in process.env) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
