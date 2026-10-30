export type V2PositionStatus = "CLOSED" | "OPEN" | "REDEEMABLE";

export interface V2PositionRow {
  proxy_wallet: string;
  token_id: string;
  condition_id: string;
  current_size: number;
  realized_pnl: number;
  unrealized_pnl: number;
  total_pnl: number;
  status: V2PositionStatus | string;
  redeemable: boolean;
  title?: string;
  slug?: string;
  event_id?: string;
  event_slug?: string;
  last_event_at?: number;
  first_entry_at?: number;
  current_price?: number;
  current_value?: number;
  percent_pnl?: number;
}

export interface V2PositionsResponse {
  data: V2PositionRow[];
  pagination?: {
    limit?: number;
    offset?: number;
    has_more?: boolean;
    next_cursor?: string;
  };
}

export interface V2UserPnlPoint {
  timestamp: number;
  realized_pnl?: number;
  realized_market_pnl?: number;
  position_pnl?: number;
  trade_count?: number;
}

export interface V2UserPnlResponse {
  data?: {
    points?: V2UserPnlPoint[];
  };
}
