import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface WorkerEnvStatus {
  DATABASE_URL: boolean;
  OPENAI_API_KEY: boolean;
  ODDS_API_KEY: boolean;
  UPSTASH_REDIS_REST_URL: boolean;
  UPSTASH_REDIS_REST_TOKEN: boolean;
  CRON_SECRET: boolean;
  SHADOW_CRON_MODE: string;
}

const REQUIRED_ENV_KEYS = ["DATABASE_URL"] as const;

function isTruthyEnv(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/**
 * Generate the Prisma client (idempotent). Safe to run on every cloud worker boot.
 *
 * Non-fatal: `build:worker` and `postinstall` already generate the client, so a
 * failure here (no schema on disk, npx unreachable) must not crash-loop a worker
 * that has a perfectly usable generated client.
 */
export function ensurePrismaClientGenerated(): void {
  if (process.env.SKIP_WORKER_PRISMA_GENERATE === "1") {
    console.log("[Worker] Skipping prisma generate (SKIP_WORKER_PRISMA_GENERATE=1)");
    return;
  }

  const schemaPath = join(process.cwd(), "prisma", "schema.prisma");
  if (!existsSync(schemaPath)) {
    console.warn(
      `[Worker] Prisma schema not found at ${schemaPath} — using the client generated at build time`
    );
    return;
  }

  console.log("[Worker] Running prisma generate...");
  try {
    execSync("npx prisma generate", {
      stdio: "inherit",
      env: process.env,
    });
  } catch (error) {
    console.warn(
      "[Worker] prisma generate failed — falling back to the client generated at build time:",
      error instanceof Error ? error.message : error
    );
  }
}

export function collectWorkerEnvStatus(): WorkerEnvStatus {
  return {
    DATABASE_URL: isTruthyEnv(process.env.DATABASE_URL),
    OPENAI_API_KEY: isTruthyEnv(process.env.OPENAI_API_KEY),
    ODDS_API_KEY: isTruthyEnv(process.env.ODDS_API_KEY),
    UPSTASH_REDIS_REST_URL: isTruthyEnv(process.env.UPSTASH_REDIS_REST_URL),
    UPSTASH_REDIS_REST_TOKEN: isTruthyEnv(
      process.env.UPSTASH_REDIS_REST_TOKEN
    ),
    CRON_SECRET: isTruthyEnv(process.env.CRON_SECRET),
    SHADOW_CRON_MODE: (process.env.SHADOW_CRON_MODE ?? "daemon").trim(),
  };
}

/**
 * Validate cloud worker configuration.
 * All secrets must be injected via `process.env` (Render, Railway, Fly, Vercel, etc.).
 */
export function validateWorkerEnvironment(): WorkerEnvStatus {
  const missingRequired = REQUIRED_ENV_KEYS.filter(
    (key) => !isTruthyEnv(process.env[key])
  );

  if (missingRequired.length > 0) {
    throw new Error(
      `[Worker] Missing required environment variables: ${missingRequired.join(", ")}`
    );
  }

  const status = collectWorkerEnvStatus();
  console.log("[Worker] Environment loaded from process.env:", status);

  if (!status.OPENAI_API_KEY) {
    console.warn(
      "[Worker] OPENAI_API_KEY is unset — trade EV / ensemble fallback will be degraded"
    );
  }
  if (!status.UPSTASH_REDIS_REST_URL || !status.UPSTASH_REDIS_REST_TOKEN) {
    console.warn(
      "[Worker] Upstash Redis is unset — EV cache and pipeline locks use in-process fallback"
    );
  }

  return status;
}

export function bootstrapCloudWorker(): WorkerEnvStatus {
  ensurePrismaClientGenerated();
  return validateWorkerEnvironment();
}
