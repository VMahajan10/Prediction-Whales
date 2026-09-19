export interface EtherscanRequestTimings {
  requestStartedAt: number;
  fetchStartedAt: number;
  headersReceivedAt: number | null;
  bodyReadStartedAt: number | null;
  bodyReadCompletedAt: number | null;
  requestEndedAt: number | null;
  abortTriggeredAt: number | null;
  timeoutMs: number;
  urlHost: string;
}

export function createEtherscanRequestTimings(
  timeoutMs: number,
  url: string
): EtherscanRequestTimings {
  const now = Date.now();
  let host = "unknown";
  try {
    host = new URL(url).host;
  } catch {
    // ignore
  }
  return {
    requestStartedAt: now,
    fetchStartedAt: now,
    headersReceivedAt: null,
    bodyReadStartedAt: null,
    bodyReadCompletedAt: null,
    requestEndedAt: null,
    abortTriggeredAt: null,
    timeoutMs,
    urlHost: host,
  };
}

export function summarizeEtherscanHangPhase(
  timings: EtherscanRequestTimings
): string {
  if (timings.abortTriggeredAt == null) return "unknown";
  if (timings.headersReceivedAt == null) return "connect_or_headers";
  if (timings.bodyReadCompletedAt == null) return "body_download_or_json_parse";
  return "post_body";
}

export function logEtherscanTimeoutDiagnostics(
  timings: EtherscanRequestTimings,
  attempt: number
): void {
  const elapsedMs = (timings.abortTriggeredAt ?? Date.now()) - timings.requestStartedAt;
  const phase = summarizeEtherscanHangPhase(timings);
  console.error(
    `[etherscan-timeout] attempt=${attempt} elapsedMs=${elapsedMs} timeoutMs=${timings.timeoutMs} phase=${phase} host=${timings.urlHost} ` +
      `started=${timings.requestStartedAt} headers=${timings.headersReceivedAt ?? "none"} ` +
      `bodyStart=${timings.bodyReadStartedAt ?? "none"} bodyEnd=${timings.bodyReadCompletedAt ?? "none"} ` +
      `abortAt=${timings.abortTriggeredAt ?? "none"}`
  );
}
