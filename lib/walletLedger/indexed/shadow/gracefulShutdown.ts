export type ShutdownReason =
  | "sigterm"
  | "sigint"
  | "invocation_deadline"
  | "wallet_deadline";

let shutdownRequested = false;
let shutdownReason: ShutdownReason | null = null;
let shutdownAbortController: AbortController | null = null;
let shutdownHandler: ((reason: ShutdownReason) => Promise<void>) | null = null;
let shutdownInFlight: Promise<void> | null = null;

export function isShutdownRequested(): boolean {
  return shutdownRequested;
}

export function getShutdownReason(): ShutdownReason | null {
  return shutdownReason;
}

export function requestShutdown(reason: ShutdownReason): void {
  if (shutdownRequested) return;
  shutdownRequested = true;
  shutdownReason = reason;
  shutdownAbortController?.abort(
    new Error(`graceful_shutdown:${reason}`)
  );
}

export function createCombinedAbortSignal(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const controller = new AbortController();
  const onAbort = (signal: AbortSignal) => {
    if (controller.signal.aborted) return;
    controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      onAbort(signal);
      break;
    }
    signal.addEventListener("abort", () => onAbort(signal), { once: true });
  }
  return controller.signal;
}

export function registerWalletWorkerShutdown(input: {
  onShutdown: (reason: ShutdownReason) => Promise<void>;
}): AbortSignal {
  shutdownAbortController = new AbortController();
  shutdownHandler = input.onShutdown;

  const handleSignal = (reason: ShutdownReason) => {
    requestShutdown(reason);
    if (!shutdownInFlight) {
      shutdownInFlight = (async () => {
        try {
          await shutdownHandler?.(reason);
        } finally {
          process.exit(130);
        }
      })();
    }
  };

  process.once("SIGTERM", () => handleSignal("sigterm"));
  process.once("SIGINT", () => handleSignal("sigint"));

  return shutdownAbortController.signal;
}

export function resetWalletWorkerShutdownForTests(): void {
  shutdownRequested = false;
  shutdownReason = null;
  shutdownAbortController = null;
  shutdownHandler = null;
  shutdownInFlight = null;
}
