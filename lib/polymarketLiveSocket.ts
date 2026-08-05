import { fetchTokenRegistry, type TokenMarketMeta } from "@/lib/polymarket";
import { shouldBroadcastQualifiedSocketTrade } from "@/lib/feedSocketGateWorker";
import type { SocketTrade } from "@/lib/types/socket";

export type { SocketTrade } from "@/lib/types/socket";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

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
  /** @deprecated Tiered stake floors are enforced in feedSocketGateWorker. */
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
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(private readonly options: PolymarketLiveSocketOptions) {}

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
  }

  stop(): void {
    this.stopped = true;
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
        void this.handleEvent(event as LastTradePriceEvent);
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

    const qualified = await shouldBroadcastQualifiedSocketTrade(trade);
    if (!qualified) return;

    await this.options.onTrade(trade);
  }
}
