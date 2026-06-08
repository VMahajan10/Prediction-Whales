import { useCallback, useEffect, useRef, useState } from "react";

export interface SocketTrade {
  id: string;
  title: string;
  side: "BUY" | "SELL";
  outcome: string;
  price: number;
  size: number;
  timestamp: number;
  transactionHash: string;
}

interface RawTradeEvent {
  id?: string;
  size?: number | string;
  usdcSize?: number | string;
  price?: number | string;
  market?: string;
  title?: string;
  side?: string;
  outcome?: string;
  timestamp?: number;
  transactionHash?: string;
  tx_hash?: string;
  event_type?: string;
  type?: string;
}

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export function usePolymarketSocket(maxTrades = 50) {
  const [trades, setTrades] = useState<SocketTrade[]>([]);
  const [connected, setConnected] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const attemptCount = useRef(0);
  const MAX_ATTEMPTS = 3;
  const isMounted = useRef(true);
  const isConnecting = useRef(false);

  const connect = useCallback(() => {
    if (!isMounted.current) return;
    if (isConnecting.current) return;
    if (attemptCount.current >= MAX_ATTEMPTS) return;

    isConnecting.current = true;
    attemptCount.current++;

    try {
      ws.current = new WebSocket(WS_URL);

      ws.current.onopen = async () => {
        if (!isMounted.current) return;
        isConnecting.current = false;
        setConnected(true);

        try {
          const res = await fetch("/api/markets");
          const data = await res.json();
          const tokenIds = (data.markets ?? [])
            .filter((m: { clobTokenIds?: string[] }) => m.clobTokenIds?.length)
            .slice(0, 10)
            .map((m: { clobTokenIds: string[] }) => m.clobTokenIds[0]);

          if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(
              JSON.stringify({
                type: "subscribe",
                channel: "market",
                markets: tokenIds,
              })
            );
            ws.current.send(
              JSON.stringify({
                type: "subscribe",
                channel: "trade",
                markets: tokenIds,
              })
            );
          }
        } catch {
          // Subscription failed silently
        }
      };

      ws.current.onmessage = (event) => {
        if (!isMounted.current) return;
        try {
          const data = JSON.parse(event.data as string) as
            | RawTradeEvent
            | RawTradeEvent[];
          const events = Array.isArray(data) ? data : [data];
          const newTrades: SocketTrade[] = [];

          events.forEach((e) => {
            if (
              e.event_type === "trade" ||
              e.type === "trade" ||
              (e.price && e.size && e.side)
            ) {
              const size = parseFloat(String(e.size ?? e.usdcSize ?? 0));
              const price = parseFloat(String(e.price ?? 0));
              if (size >= 1 && price > 0) {
                newTrades.push({
                  id: e.id ?? `${Date.now()}-${Math.random()}`,
                  title: e.market ?? e.title ?? "Unknown",
                  side: (e.side ?? "BUY").toUpperCase() as "BUY" | "SELL",
                  outcome: e.outcome ?? "",
                  price,
                  size,
                  timestamp: e.timestamp ?? Math.floor(Date.now() / 1000),
                  transactionHash: e.transactionHash ?? e.tx_hash ?? "",
                });
              }
            }
          });

          if (newTrades.length > 0) {
            setTrades((prev) =>
              [...newTrades, ...prev].slice(0, maxTrades)
            );
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.current.onclose = () => {
        if (!isMounted.current) return;
        isConnecting.current = false;
        setConnected(false);

        if (attemptCount.current < MAX_ATTEMPTS) {
          const delay = attemptCount.current * 3000;
          reconnectTimer.current = setTimeout(connect, delay);
        }
      };

      ws.current.onerror = () => {
        isConnecting.current = false;
        ws.current?.close();
      };
    } catch {
      isConnecting.current = false;
    }
  }, [maxTrades]);

  useEffect(() => {
    isMounted.current = true;
    const timer = setTimeout(connect, 500);

    return () => {
      isMounted.current = false;
      clearTimeout(timer);
      clearTimeout(reconnectTimer.current);
      if (ws.current) {
        ws.current.onclose = null;
        ws.current.onerror = null;
        ws.current.onmessage = null;
        ws.current.close();
        ws.current = null;
      }
    };
  }, [connect]);

  return { trades, connected };
}
