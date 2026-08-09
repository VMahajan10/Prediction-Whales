import { fetchTokenRegistry, type TokenMarketMeta } from "@/lib/polymarket";
import { MIN_RAW_INGESTION_STAKE_USD } from "@/lib/feedQualification";
import type { SocketTrade } from "@/lib/types/socket";

export type { SocketTrade } from "@/lib/types/socket";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const REGISTRY_REFRESH_MS = 10 * 60 * 1000;
const MAX_SEEN_HASHES = 50_000;

interface TokenRegistry {
  tokenIds: string[];
  tokens: Record<string, TokenMarketMeta>;
}

interface LastTradePriceEvent {
  event_type?: string;
  asset_id?: string;
  market?: string;
  price?: string;
  size?: string;
  side?: "BUY" | "SELL";
  timestamp?: string;
  transaction_hash?: string;
}

export interface PolymarketLiveSocketOptions {
  onTrade: (trade: SocketTrade) => void | Promise<void>;
  /** Raw ingestion floor — defaults to {@link MIN_RAW_INGESTION_STAKE_USD}. */
  minUsdNotional?: number;
}

function getWebSocketCtor(): typeof WebSocket {
  if (typeof globalThis.WebSocket !== "undefined") {
    return globalThis.WebSocket;
  }
  throw new Error(
    "[polymarketLiveSocket] WebSocket is unavailable — use Node.js 20+ for shadow cron live mode"
  );
}

/**
 * Node-side Polymarket CLOB market WebSocket (same feed as `usePolymarketSocket`).
 */
export class PolymarketLiveSocket {
  private readonly seenHashes = new Set<string>();
  private registry: TokenRegistry = { tokenIds: [], tokens: {} };
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private registryTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(private readonly options: PolymarketLiveSocketOptions) {}

  private get ingestionMinUsd(): number {
    const configured = this.options.minUsdNotional;
    if (configured != null && Number.isFinite(configured) && configured >= 0) {
      return configured;
    }
    return MIN_RAW_INGESTION_STAKE_USD;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async start(): Promise<void> {
    this.stopped = false;
    try {
      this.registry = await fetchTokenRegistry();
    } catch (error) {
      console.warn("[polymarketLiveSocket] token registry fetch failed", {
        error: error instanceof Error ? error.message : error,
      });
      this.registry = { tokenIds: [], tokens: {} };
    }

    if (this.registry.tokenIds.length === 0) {
      throw new Error(
        "[polymarketLiveSocket] token registry is empty — cannot subscribe to live trades"
      );
    }

    this.connect();

    this.registryTimer = setInterval(() => {
      void this.refreshRegistry();
    }, REGISTRY_REFRESH_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.registryTimer) {
      clearInterval(this.registryTimer);
      this.registryTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private async refreshRegistry(): Promise<void> {
    if (this.stopped) return;
    try {
      const next = await fetchTokenRegistry();
      if (next.tokenIds.length === 0) return;

      const added = next.tokenIds.filter((id) => !this.registry.tokens[id]);
      this.registry = next;
      if (added.length === 0) return;

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ type: "market", assets_ids: next.tokenIds })
        );
      }
      console.log(
        `[polymarketLiveSocket] registry refreshed — +${added.length} tokens (${next.tokenIds.length} total)`
      );
    } catch (error) {
      console.warn("[polymarketLiveSocket] registry refresh failed", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const tokenIds = this.registry.tokenIds;
    if (tokenIds.length === 0) return;

    const WebSocketCtor = getWebSocketCtor();
    let ws: WebSocket;
    try {
      ws = new WebSocketCtor(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: "market", assets_ids: tokenIds }));

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10_000);
    };

    ws.onmessage = (ev) => {
      const text = typeof ev.data === "string" ? ev.data : "";
      if (!text || text === "PONG") return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }

      const events = Array.isArray(parsed) ? parsed : [parsed];
      for (const event of events) {
        void this.handleEvent(event as LastTradePriceEvent).catch((error) => {
          console.warn("[polymarketLiveSocket] trade handler failed", {
            error: error instanceof Error ? error.message : error,
          });
        });
      }
    };

    ws.onerror = () => ws.close();

    ws.onclose = () => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.ws = null;
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 15_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async handleEvent(raw: LastTradePriceEvent): Promise<void> {
    if (raw.event_type !== "last_trade_price") return;
    const hash = raw.transaction_hash;
    if (!hash || this.seenHashes.has(hash)) return;

    const price = parseFloat(raw.price ?? "0");
    const shares = parseFloat(raw.size ?? "0");
    const usdNotional = price * shares;
    if (!Number.isFinite(usdNotional) || usdNotional <= 0) return;

    this.seenHashes.add(hash);
    if (this.seenHashes.size > MAX_SEEN_HASHES) {
      const excess = this.seenHashes.size - MAX_SEEN_HASHES;
      let removed = 0;
      for (const key of this.seenHashes) {
        this.seenHashes.delete(key);
        if (++removed >= excess) break;
      }
    }

    const meta = raw.asset_id ? this.registry.tokens[raw.asset_id] : undefined;
    const trade: SocketTrade = {
      id: hash,
      title: meta?.title ?? "Unknown market",
      side: raw.side ?? "BUY",
      outcome: meta?.outcome ?? "",
      price,
      size: shares,
      usdNotional,
      timestamp: raw.timestamp
        ? Math.floor(Number(raw.timestamp) / 1000)
        : Math.floor(Date.now() / 1000),
      transactionHash: hash,
      assetId: raw.asset_id,
      eventSlug: meta?.eventSlug,
      slug: meta?.slug,
      conditionId: meta?.conditionId ?? raw.market,
    };

    if (usdNotional < this.ingestionMinUsd) return;

    await this.options.onTrade(trade);
  }
}
