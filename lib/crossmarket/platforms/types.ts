/** Shared types for Tier-1 cross-market platform fetchers. */

export type Tier = 1 | 2 | 3;

/** Platforms with REST fetchers in Phase 1. */
export type Tier1PlatformId = "kalshi" | "manifold" | "metaculus";

export type PlatformId =
  | Tier1PlatformId
  | "polymarket"
  | "predictit"
  | "smarkets"
  | "betfair"
  | "draftkings"
  | "fanduel";

/** What `yes_price` represents when present. */
export type YesPriceKind = "tradeable" | "forecast_consensus";

/**
 * Raw market row from a platform API — maps 1:1 to `markets_raw` columns
 * (minus DB `id` / `ingested_at`).
 */
export interface RawMarket {
  platform: PlatformId;
  external_id: string;
  tier: Tier;
  title: string;
  raw_payload: Record<string, unknown>;
  /** Null when missing — never substitute 0.5 or other placeholders. */
  yes_price: number | null;
  volume: number | null;
  url: string | null;
  /**
   * `tradeable` — exchange/AMM price (Kalshi, Manifold).
   * `forecast_consensus` — Metaculus community median, not a tradeable quote.
   */
  yes_price_kind?: YesPriceKind;
}

/** Canonical normalized form (written to `markets_normalized` in STEP 4). */
export interface NormalizedMarket {
  canonicalTitle: string;
  entities: string[];
  resolutionKind?: string;
  normMethod: "rule" | "llm";
}

export type PlatformFetcher = () => Promise<RawMarket[]>;

export interface PlatformRegistryEntry {
  id: Tier1PlatformId;
  tier: Tier;
  /** 0–1 weight prior for EV consensus (higher = more trusted). */
  reliability: number;
  fetch: PlatformFetcher;
  /** Human-readable note on what yes_price means for this platform. */
  priceNote: string;
}
