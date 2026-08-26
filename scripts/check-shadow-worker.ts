import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import {
  classifyWorkerStatus,
  formatWorkerStatusReport,
  isShadowWorkerRedisEnabled,
  readShadowWorkerHeartbeat,
} from "@/lib/x-agent/shadowWorkerHeartbeat";

async function main(): Promise<void> {
  if (!isShadowWorkerRedisEnabled()) {
    console.log("Worker status: OFFLINE");
    console.log("Last heartbeat: Redis not configured");
    process.exit(1);
    return;
  }

  const heartbeat = await readShadowWorkerHeartbeat();
  console.log(formatWorkerStatusReport(heartbeat));
  process.exit(classifyWorkerStatus(heartbeat) === "ONLINE" ? 0 : 1);
}

void main().catch((error) => {
  console.error(
    "[check:worker] failed:",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});
