/** Verbose x-agent / shadow-cron logs (gate matrix, drops, tick heartbeats). */
export function isVerboseXAgentLoggingEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" || process.env.DEBUG_LOGS === "true"
  );
}
