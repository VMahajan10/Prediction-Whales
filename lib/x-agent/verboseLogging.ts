import { isDebugLoggingEnabled } from "@/lib/logger";

/** Verbose x-agent / shadow-cron logs (gate matrix, drops, tick heartbeats). */
export function isVerboseXAgentLoggingEnabled(): boolean {
  return isDebugLoggingEnabled();
}
