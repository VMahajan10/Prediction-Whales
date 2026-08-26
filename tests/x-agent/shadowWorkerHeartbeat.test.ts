import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHADOW_WORKER_HEARTBEAT_KEY,
  SHADOW_WORKER_HEARTBEAT_TTL_SEC,
  buildShadowWorkerHeartbeatPayload,
  classifyWorkerStatus,
  formatWorkerStatusReport,
  isShadowDaemonHeartbeatMode,
  readShadowWorkerHeartbeat,
  resetShadowWorkerHeartbeatStateForTests,
  setShadowWorkerWebSocketConnected,
  startShadowWorkerHeartbeat,
  writeShadowWorkerHeartbeat,
} from "@/lib/x-agent/shadowWorkerHeartbeat";

describe("shadowWorkerHeartbeat", () => {
  const mockSet = vi.fn().mockResolvedValue("OK");
  const mockGet = vi.fn().mockResolvedValue(null);
  const mockClient = { set: mockSet, get: mockGet };

  beforeEach(() => {
    vi.useFakeTimers();
    resetShadowWorkerHeartbeatStateForTests();
    mockSet.mockClear();
    mockGet.mockClear();
    delete process.env.RENDER_GIT_COMMIT;
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetShadowWorkerHeartbeatStateForTests();
  });

  it("daemon mode publishes heartbeat; backfill does not", () => {
    expect(isShadowDaemonHeartbeatMode("daemon")).toBe(true);
    expect(isShadowDaemonHeartbeatMode(undefined)).toBe(true);
    expect(isShadowDaemonHeartbeatMode("backfill")).toBe(false);
    expect(isShadowDaemonHeartbeatMode("batch")).toBe(false);
  });

  it("daemon writes heartbeat immediately and every 60 seconds", async () => {
    startShadowWorkerHeartbeat(mockClient);
    await Promise.resolve();
    expect(mockSet).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockSet).toHaveBeenCalledTimes(2);
  });

  it("writes heartbeat payload to Redis with TTL", async () => {
    process.env.RENDER_GIT_COMMIT = "d575aadde49699c3c718a4e2306a6b7203b4fb2b";
    await writeShadowWorkerHeartbeat(mockClient);

    expect(mockSet).toHaveBeenCalledWith(
      SHADOW_WORKER_HEARTBEAT_KEY,
      expect.objectContaining({
        mode: "daemon",
        commit: "d575aadde49699c3c718a4e2306a6b7203b4fb2b",
        websocketConnected: false,
      }),
      { ex: SHADOW_WORKER_HEARTBEAT_TTL_SEC }
    );
  });

  it("updates websocketConnected on write after socket connect", async () => {
    setShadowWorkerWebSocketConnected(true);
    await writeShadowWorkerHeartbeat(mockClient);

    expect(mockSet).toHaveBeenCalledWith(
      SHADOW_WORKER_HEARTBEAT_KEY,
      expect.objectContaining({ websocketConnected: true }),
      { ex: SHADOW_WORKER_HEARTBEAT_TTL_SEC }
    );
  });

  it("reports ONLINE for a fresh heartbeat", () => {
    const now = Date.parse("2026-08-25T12:00:00.000Z");
    const heartbeat = buildShadowWorkerHeartbeatPayload(
      new Date("2026-08-25T11:59:40.000Z")
    );
    heartbeat.commit = "d575aadde49699c3c718a4e2306a6b7203b4fb2b";
    heartbeat.websocketConnected = true;

    expect(classifyWorkerStatus(heartbeat, now)).toBe("ONLINE");
    expect(formatWorkerStatusReport(heartbeat, now)).toBe(
      [
        "Worker status: ONLINE",
        "Mode: daemon",
        "Commit: d575aad",
        "Last heartbeat: 20s ago",
        "WebSocket: connected",
      ].join("\n")
    );
  });

  it("reports OFFLINE for a stale heartbeat", () => {
    const now = Date.parse("2026-08-25T12:00:00.000Z");
    const heartbeat = buildShadowWorkerHeartbeatPayload(
      new Date("2026-08-25T11:52:00.000Z")
    );

    expect(classifyWorkerStatus(heartbeat, now)).toBe("OFFLINE");
    expect(formatWorkerStatusReport(heartbeat, now)).toBe(
      ["Worker status: OFFLINE", "Last heartbeat: 8m ago"].join("\n")
    );
  });

  it("reports OFFLINE when heartbeat key is missing", async () => {
    mockGet.mockResolvedValueOnce(null);
    const heartbeat = await readShadowWorkerHeartbeat(mockClient);
    expect(formatWorkerStatusReport(heartbeat)).toBe(
      ["Worker status: OFFLINE", "Last heartbeat: not found"].join("\n")
    );
  });
});
