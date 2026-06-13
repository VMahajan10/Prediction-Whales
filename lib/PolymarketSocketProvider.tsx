"use client";

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import {
  usePolymarketSocket,
  type SocketTrade,
} from "@/lib/usePolymarketSocket";

interface PolymarketSocketContextValue {
  trades: SocketTrade[];
  whaleTrades: SocketTrade[];
  connected: boolean;
}

const PolymarketSocketContext =
  createContext<PolymarketSocketContextValue | null>(null);

export function PolymarketSocketProvider({ children }: { children: ReactNode }) {
  const value = usePolymarketSocket();
  return (
    <PolymarketSocketContext.Provider value={value}>
      {children}
    </PolymarketSocketContext.Provider>
  );
}

export function usePolymarketSocketContext(): PolymarketSocketContextValue {
  const ctx = useContext(PolymarketSocketContext);
  if (!ctx) {
    throw new Error(
      "usePolymarketSocketContext must be used within PolymarketSocketProvider"
    );
  }
  return ctx;
}
