"use client";

import { useEffect, useRef, useState } from "react";
import { shouldBroadcastQualifiedSocketTrade } from "@/lib/feedSocketGate";
import type { SocketTrade } from "@/lib/socketTrade";
import type { TokenMarketMeta } from "@/lib/polymarket";

export type { SocketTrade } from "@/lib/socketTrade";

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

/**
 * Live whale detection via the Polymarket CLOB market WebSocket.
 *
 * The Data REST API is fronted by Cloudflare with `max-age=300`, so polling it
 * can never beat ~5 minutes of staleness. The CLOB market socket pushes
 * `last_trade_price` events with sub-second latency (measured median ~0s),
 * including size, side, price and transaction_hash — everything we need. We
 * map asset_id -> market metadata using the token registry from Gamma.
 */
export function usePolymarketSocket(maxTrades = 50) {
  const [trades, setTrades] = useState<SocketTrade[]>([]);
  const [whaleTrades, setWhaleTrades] = useState<SocketTrade[]>([]);
  const [connected, setConnected] = useState(false);

  const seenHashes = useRef<Set<string>>(new Set());
  const registryRef = useRef<TokenRegistry>({ tokenIds: [], tokens: {} });
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMounted = useRef(true);
  const reconnectAttempts = useRef(0);

  useEffect(() => {
    isMounted.current = true;

    const handleEvent = (raw: LastTradePriceEvent) => {
      if (raw.event_type !== "last_trade_price") return;
      const hash = raw.transaction_hash;
      if (!hash || seenHashes.current.has(hash)) return;

      const price = parseFloat(raw.price ?? "0");
      const shares = parseFloat(raw.size ?? "0");
      const usdNotional = price * shares;
      if (!Number.isFinite(usdNotional) || usdNotional <= 0) return;

      seenHashes.current.add(hash);

      const meta = raw.asset_id
        ? registryRef.current.tokens[raw.asset_id]
        : undefined;

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

      setTrades((prev) => [trade, ...prev].slice(0, maxTrades));

      void shouldBroadcastQualifiedSocketTrade(trade).then((qualified) => {
        if (!qualified || !isMounted.current) return;
        setWhaleTrades((prev) => [trade, ...prev].slice(0, 50));
      });
    };

    const connect = () => {
      const tokenIds = registryRef.current.tokenIds;
      if (tokenIds.length === 0) return;

      let ws: WebSocket;
      try {
        ws = new WebSocket(WS_URL);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempts.current = 0;
        ws.send(JSON.stringify({ type: "market", assets_ids: tokenIds }));
        if (isMounted.current) setConnected(true);

        if (pingTimer.current) clearInterval(pingTimer.current);
        pingTimer.current = setInterval(() => {
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
        for (const e of events) handleEvent(e as LastTradePriceEvent);
      };

      ws.onerror = () => ws.close();

      ws.onclose = () => {
        if (pingTimer.current) {
          clearInterval(pingTimer.current);
          pingTimer.current = null;
        }
        if (isMounted.current) {
          setConnected(false);
          scheduleReconnect();
        }
      };
    };

    const scheduleReconnect = () => {
      if (!isMounted.current || reconnectTimer.current) return;
      const delay = Math.min(
        1_000 * 2 ** reconnectAttempts.current,
        15_000
      );
      reconnectAttempts.current += 1;
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        connect();
      }, delay);
    };

    const bootstrap = async () => {
      try {
        const res = await fetch("/api/markets/tokens");
        const registry = (await res.json()) as TokenRegistry;
        if (!isMounted.current) return;
        registryRef.current = {
          tokenIds: registry.tokenIds ?? [],
          tokens: registry.tokens ?? {},
        };
      } catch {
        registryRef.current = { tokenIds: [], tokens: {} };
      }
      connect();
    };

    void bootstrap();

    return () => {
      isMounted.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pingTimer.current) clearInterval(pingTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [maxTrades]);

  return { trades, whaleTrades, connected };
}
