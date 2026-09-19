import { Worker } from "node:worker_threads";
import {
  EtherscanNoProgressTimeout,
  EtherscanQueryMaxRuntimeError,
} from "@/lib/walletLedger/indexed/etherscanErrors";
import { yieldToEventLoop } from "@/lib/walletLedger/indexed/etherscanQueryController";

export const ETHERSCAN_JSON_PARSE_WORKER_THRESHOLD_BYTES = 256 * 1024;

export interface EtherscanLogsApiResponse {
  status: string;
  message: string;
  result: unknown;
}

function abortErrorFromSignal(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof EtherscanQueryMaxRuntimeError) return reason;
  if (reason instanceof EtherscanNoProgressTimeout) return reason;
  if (reason instanceof Error) return reason;
  return new EtherscanNoProgressTimeout(
    typeof reason === "string" ? reason : "Etherscan JSON parse aborted",
    undefined,
    "json_parse"
  );
}

function parseJsonInWorker(
  bodyText: string,
  signal?: AbortSignal
): Promise<EtherscanLogsApiResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       try {
         parentPort.postMessage({ ok: true, value: JSON.parse(workerData) });
       } catch (error) {
         parentPort.postMessage({
           ok: false,
           message: error instanceof Error ? error.message : String(error),
         });
       }`,
      { eval: true, workerData: bodyText }
    );

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      void worker.terminate().catch(() => undefined);
      finish(() => reject(abortErrorFromSignal(signal)));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (message: { ok: boolean; value?: unknown; message?: string }) => {
      finish(() => {
        void worker.terminate().catch(() => undefined);
        if (!message.ok) {
          reject(new Error(message.message ?? "json worker parse failed"));
          return;
        }
        resolve(message.value as EtherscanLogsApiResponse);
      });
    });
    worker.on("error", (error) => {
      finish(() => {
        void worker.terminate().catch(() => undefined);
        reject(error);
      });
    });
    worker.on("exit", (code) => {
      if (settled || code === 0) return;
      finish(() => reject(new Error(`etherscan json worker exited with code ${code}`)));
    });
  });
}

export async function parseEtherscanJsonBody(
  bodyText: string,
  signal?: AbortSignal,
  throwIfAborted?: () => void
): Promise<EtherscanLogsApiResponse> {
  throwIfAborted?.();
  await yieldToEventLoop(signal);
  throwIfAborted?.();

  if (bodyText.length <= ETHERSCAN_JSON_PARSE_WORKER_THRESHOLD_BYTES) {
    return JSON.parse(bodyText) as EtherscanLogsApiResponse;
  }

  return parseJsonInWorker(bodyText, signal);
}
