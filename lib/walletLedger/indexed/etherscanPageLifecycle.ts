import { auditLog } from "@/lib/walletLedger/indexed/auditProgress";

export type EtherscanPageLifecyclePhase =
  | "page_scheduled"
  | "limiter_wait_start"
  | "limiter_acquired"
  | "retry_attempt_start"
  | "fetch_start"
  | "headers_received"
  | "body_complete"
  | "json_parsed"
  | "page_processed"
  | "checkpoint_committed"
  | "limiter_released"
  | "request_complete";

export interface EtherscanPageLifecycleEvent {
  phase: EtherscanPageLifecyclePhase;
  wallet: string;
  queryIndex: number;
  queryTotal: number;
  rangeFrom: number;
  rangeTo: number;
  page: number;
  attempt: number;
  requestId: string;
  elapsedMs: number;
}

let requestCounter = 0;

export function nextEtherscanRequestId(): string {
  requestCounter += 1;
  return `es-${Date.now().toString(36)}-${requestCounter}`;
}

export function logEtherscanPageLifecycle(event: EtherscanPageLifecycleEvent): void {
  auditLog(
    [
      "[etherscan-lifecycle]",
      `phase=${event.phase}`,
      `wallet=${event.wallet}`,
      `query=${event.queryIndex}/${event.queryTotal}`,
      `range=${event.rangeFrom}-${event.rangeTo}`,
      `page=${event.page}`,
      `attempt=${event.attempt}`,
      `requestId=${event.requestId}`,
      `elapsedMs=${event.elapsedMs}`,
    ].join(" ")
  );
}
