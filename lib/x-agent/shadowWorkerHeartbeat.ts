import { Redis } from "@upstash/redis";

/** Redis key for the live Render shadow daemon heartbeat. */
export const SHADOW_WORKER_HEARTBEAT_KEY = "shadow-worker:heartbeat";

/** TTL — worker is offline when the key expires (3–5 minute window). */
export const SHADOW_WORKER_HEARTBEAT_TTL_SEC = 300;

export const SHADOW_WORKER_HEARTBEAT_INTERVAL_MS = 60_000;

export interface ShadowWorkerHeartbeatPayload {
  timestamp: string;
  mode: "daemon";
  processStartedAt: string;
  nodeEnv: string;
  commit: string | null;
  buildId: string | null;
  websocketConnected: boolean;
}

type RedisHeartbeatClient = Pick<Redis, "get" | "set">;

let redisClient: Redis | null = null;
let heartbeatRedisClient: RedisHeartbeatClient | null = null;
let websocketConnected = false;
let processStartedAt: string | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

export function isShadowWorkerRedisEnabled(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );
}

function getShadowWorkerRedis(): RedisHeartbeatClient | null {
  if (!isShadowWorkerRedisEnabled()) return null;
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return redisClient;
}

/** Only the perpetual Render daemon should publish the heartbeat. */
export function isShadowDaemonHeartbeatMode(mode: string | undefined): boolean {
  const normalized = (mode ?? "daemon").trim().toLowerCase();
  return normalized === "daemon";
}

export function resolveShadowWorkerGitCommit(): string | null {
  for (const value of [
    process.env.RENDER_GIT_COMMIT,
    process.env.GIT_COMMIT,
    process.env.VERCEL_GIT_COMMIT_SHA,
  ]) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function resolveShadowWorkerBuildId(): string | null {
  const service = process.env.RENDER_SERVICE_NAME?.trim();
  const instance = process.env.RENDER_INSTANCE_ID?.trim();
  if (service && instance) return `${service}:${instance}`;
  if (service) return service;
  return null;
}

export function formatCommitShort(commit: string | null | undefined): string {
  if (!commit?.trim()) return "unknown";
  const trimmed = commit.trim();
  return trimmed.length > 7 ? trimmed.slice(0, 7) : trimmed;
}

export function classifyWorkerStatus(
  heartbeat: ShadowWorkerHeartbeatPayload | null,
  nowMs: number = Date.now()
): "ONLINE" | "OFFLINE" {
  if (!heartbeat?.timestamp) return "OFFLINE";
  const ageMs = nowMs - Date.parse(heartbeat.timestamp);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "OFFLINE";
  if (ageMs > SHADOW_WORKER_HEARTBEAT_TTL_SEC * 1000) return "OFFLINE";
  return "ONLINE";
}

export function formatHeartbeatAge(
  iso: string,
  nowMs: number = Date.now()
): string {
  const ageSec = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  const ageMin = Math.floor(ageSec / 60);
  return `${ageMin}m ago`;
}

export function formatWorkerStatusReport(
  heartbeat: ShadowWorkerHeartbeatPayload | null,
  nowMs: number = Date.now()
): string {
  const status = classifyWorkerStatus(heartbeat, nowMs);
  if (status === "OFFLINE") {
    if (heartbeat?.timestamp) {
      return [
        "Worker status: OFFLINE",
        `Last heartbeat: ${formatHeartbeatAge(heartbeat.timestamp, nowMs)}`,
      ].join("\n");
    }
    return ["Worker status: OFFLINE", "Last heartbeat: not found"].join("\n");
  }

  return [
    "Worker status: ONLINE",
    `Mode: ${heartbeat!.mode}`,
    `Commit: ${formatCommitShort(heartbeat!.commit)}`,
    `Last heartbeat: ${formatHeartbeatAge(heartbeat!.timestamp, nowMs)}`,
    `WebSocket: ${heartbeat!.websocketConnected ? "connected" : "disconnected"}`,
  ].join("\n");
}

export function setShadowWorkerWebSocketConnected(connected: boolean): void {
  websocketConnected = connected;
}

export function buildShadowWorkerHeartbeatPayload(
  now: Date = new Date()
): ShadowWorkerHeartbeatPayload {
  if (!processStartedAt) {
    processStartedAt = now.toISOString();
  }

  return {
    timestamp: now.toISOString(),
    mode: "daemon",
    processStartedAt,
    nodeEnv: process.env.NODE_ENV ?? "unknown",
    commit: resolveShadowWorkerGitCommit(),
    buildId: resolveShadowWorkerBuildId(),
    websocketConnected,
  };
}

function resolveHeartbeatRedis(
  client?: RedisHeartbeatClient | null
): RedisHeartbeatClient | null {
  if (client !== undefined && client !== null) return client;
  if (heartbeatRedisClient) return heartbeatRedisClient;
  return getShadowWorkerRedis();
}

export async function writeShadowWorkerHeartbeat(
  client?: RedisHeartbeatClient | null
): Promise<void> {
  const redis = resolveHeartbeatRedis(client);
  if (!redis) return;

  const payload = buildShadowWorkerHeartbeatPayload();
  try {
    await redis.set(SHADOW_WORKER_HEARTBEAT_KEY, payload, {
      ex: SHADOW_WORKER_HEARTBEAT_TTL_SEC,
    });
  } catch (error) {
    console.warn(
      "[shadow-worker/heartbeat] Redis write failed:",
      error instanceof Error ? error.message : error
    );
  }
}

export async function readShadowWorkerHeartbeat(
  client?: RedisHeartbeatClient | null
): Promise<ShadowWorkerHeartbeatPayload | null> {
  const redis = resolveHeartbeatRedis(client);
  if (!redis) return null;

  try {
    const raw = await redis.get(SHADOW_WORKER_HEARTBEAT_KEY);
    if (!raw || typeof raw !== "object") return null;
    return raw as ShadowWorkerHeartbeatPayload;
  } catch (error) {
    console.warn(
      "[shadow-worker/heartbeat] Redis read failed:",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

export function startShadowWorkerHeartbeat(
  redisClientOverride?: RedisHeartbeatClient | null
): void {
  if (heartbeatInterval) return;

  heartbeatRedisClient = redisClientOverride ?? null;
  processStartedAt = new Date().toISOString();
  void writeShadowWorkerHeartbeat();

  heartbeatInterval = setInterval(() => {
    void writeShadowWorkerHeartbeat();
  }, SHADOW_WORKER_HEARTBEAT_INTERVAL_MS);
}

export function stopShadowWorkerHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/** Test helper — resets module state between vitest cases. */
export function resetShadowWorkerHeartbeatStateForTests(): void {
  stopShadowWorkerHeartbeat();
  websocketConnected = false;
  processStartedAt = null;
  redisClient = null;
  heartbeatRedisClient = null;
}
