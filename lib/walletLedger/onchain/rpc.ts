import {
  POLYGON_RPC_URLS as SHARED_RPC_URLS,
} from "@/lib/walletLedger/onchain/rpcUrls";
import type { RpcLog, RpcTransactionReceipt } from "@/lib/walletLedger/onchain/types";

export interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

export interface PolygonRpcClientOptions {
  rpcUrls?: string[];
  maxRetries?: number;
  retryDelayMs?: number;
}

export class PolygonRpcClient {
  private readonly rpcUrls: string[];
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  rpcCalls = 0;
  rateLimitHits = 0;
  retries = 0;
  errors: string[] = [];

  constructor(options: PolygonRpcClientOptions = {}) {
    this.rpcUrls = options.rpcUrls ?? SHARED_RPC_URLS;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 300;
  }

  async call<T>(method: string, params: unknown[]): Promise<T | null> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      for (const rpc of this.rpcUrls) {
        this.rpcCalls += 1;
        try {
          const res = await fetch(rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              params,
            }),
          });
          if (res.status === 429) {
            this.rateLimitHits += 1;
            continue;
          }
          const json = (await res.json()) as JsonRpcResponse<T>;
          if (json.error) {
            const msg = `${method}: ${json.error.message}`;
            if (/rate|limit|too many/i.test(msg)) this.rateLimitHits += 1;
            this.errors.push(msg);
            continue;
          }
          if (json.result !== undefined) return json.result;
        } catch (error) {
          this.errors.push(
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      if (attempt < this.maxRetries) {
        this.retries += 1;
        await sleep(this.retryDelayMs * (attempt + 1));
      }
    }
    return null;
  }

  async getBlockNumber(): Promise<number | null> {
    const hex = await this.call<string>("eth_blockNumber", []);
    return hex ? Number.parseInt(hex, 16) : null;
  }

  async getBlockTimestamp(blockNumber: number): Promise<number | null> {
    const hex = await this.call<{ timestamp: string }>("eth_getBlockByNumber", [
      `0x${blockNumber.toString(16)}`,
      false,
    ]);
    return hex?.timestamp ? Number.parseInt(hex.timestamp, 16) : null;
  }

  async getTransactionReceipt(
    hash: string
  ): Promise<RpcTransactionReceipt | null> {
    return this.call<RpcTransactionReceipt>("eth_getTransactionReceipt", [hash]);
  }

  async getLogs(filter: {
    fromBlock: number;
    toBlock: number;
    address?: string | string[];
    topics?: (string | string[] | null)[];
  }): Promise<RpcLog[]> {
    const params = {
      fromBlock: `0x${filter.fromBlock.toString(16)}`,
      toBlock: `0x${filter.toBlock.toString(16)}`,
      ...(filter.address
        ? {
            address: Array.isArray(filter.address)
              ? filter.address
              : filter.address,
          }
        : {}),
      ...(filter.topics ? { topics: filter.topics } : {}),
    };
    const logs = await this.call<RpcLog[]>("eth_getLogs", [params]);
    return logs ?? [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function walletTopic(wallet: string): string {
  return `0x${wallet.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

export function parseBlockNumber(hex: string): number {
  return Number.parseInt(hex, 16);
}

export function logDedupeKey(log: RpcLog): string {
  return `${log.transactionHash}:${log.logIndex}`;
}

export function dedupeLogs(logs: RpcLog[]): RpcLog[] {
  const map = new Map<string, RpcLog>();
  for (const log of logs) {
    map.set(logDedupeKey(log), log);
  }
  return [...map.values()];
}
