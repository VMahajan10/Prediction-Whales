/** Polymarket CLOB websocket trade shape (browser hook + Node live socket). */
export interface SocketTrade {
  id: string;
  title: string;
  side: "BUY" | "SELL";
  outcome: string;
  price: number;
  size: number;
  usdNotional: number;
  timestamp: number;
  transactionHash: string;
  assetId?: string;
  eventSlug?: string;
  slug?: string;
  conditionId?: string;
}
