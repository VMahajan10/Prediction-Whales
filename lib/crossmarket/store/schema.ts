import "server-only";

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  customType,
} from "drizzle-orm/pg-core";
import {
  X_POST_QUEUE_STATUSES,
  type XPostQueueStatus,
} from "@/lib/types/xPostQueue";
import {
  X_POST_REJECTION_REASONS,
  type XPostRejectionReason,
} from "@/lib/types/xPostRejection";

export { X_POST_QUEUE_STATUSES, type XPostQueueStatus };
export { X_POST_REJECTION_REASONS, type XPostRejectionReason };

// ---------------------------------------------------------------------------
// pgvector — text-embedding-3-small (1536 dims)
// ---------------------------------------------------------------------------

export const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return JSON.stringify(value);
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value) as number[];
  },
});

// ---------------------------------------------------------------------------
// Domain literals (mirrors section 4 + downstream EV types)
// ---------------------------------------------------------------------------

export const PLATFORMS = [
  "polymarket",
  "kalshi",
  "manifold",
  "metaculus",
  "predictit",
  "smarkets",
  "betfair",
  "draftkings",
  "fanduel",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const NORM_METHODS = ["rule", "llm"] as const;
export type NormMethod = (typeof NORM_METHODS)[number];

export const CONFIDENCE_TIERS = ["direct", "correlated", "proxy"] as const;
export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

export const MATCH_METHODS = ["deterministic", "vector", "llm"] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

/** Whether contributor YES aligns with PM YES (`same`) or is flipped (`inverted`). */
export const ORIENTATIONS = ["same", "inverted"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export const EV_SIGNALS = [
  "OVERPRICED",
  "UNDERPRICED",
  "FAIRLY_PRICED",
] as const;
export type EvSignal = (typeof EV_SIGNALS)[number];

export const SYNC_SCOPES = ["tier1", "matches", "all"] as const;
export type SyncScope = (typeof SYNC_SCOPES)[number];

export const SYNC_STATUSES = ["running", "ok", "error"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Row counts recorded at end of a sync run. */
export interface SyncRunCounts {
  ingested?: number;
  normalized?: number;
  embedded?: number;
  matched?: number;
}

/** Per-platform freshness / health for silent-failure detection. */
export interface SyncPlatformHealth {
  rows?: number;
  ingested?: number;
  /** ISO-8601 timestamp of newest markets_raw row for this platform. */
  lastIngestedAt?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// markets_raw — raw ingestion per platform (Tier 1–3)
// ---------------------------------------------------------------------------

export const marketsRaw = pgTable(
  "markets_raw",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platform: text("platform").notNull(),
    externalId: text("external_id").notNull(),
    tier: smallint("tier").notNull(),
    title: text("title").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    /** Nullable — missing contributor price must stay null, never a placeholder. */
    yesPrice: numeric("yes_price"),
    volume: numeric("volume"),
    url: text("url"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("markets_raw_platform_external_id_unique").on(
      table.platform,
      table.externalId,
    ),
    index("markets_raw_tier1_platform_ingested_idx")
      .on(table.platform, table.ingestedAt.desc())
      .where(sql`${table.tier} = 1`),
  ],
);

// ---------------------------------------------------------------------------
// markets_normalized — canonical form + embedding for vector search
// ---------------------------------------------------------------------------

export const marketsNormalized = pgTable(
  "markets_normalized",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    rawId: bigint("raw_id", { mode: "number" })
      .notNull()
      .references(() => marketsRaw.id, { onDelete: "cascade" }),
    canonicalTitle: text("canonical_title").notNull(),
    entities: text("entities").array().notNull().default(sql`'{}'::text[]`),
    resolutionKind: text("resolution_kind"),
    normMethod: text("norm_method").notNull(),
    /** Null until Phase 2 backfill; HNSW index is created regardless. */
    embedding: vector1536("embedding"),
    normalizedAt: timestamp("normalized_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("markets_normalized_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

// ---------------------------------------------------------------------------
// market_matches — polymarket_id ↔ normalized cross-platform market
// Outcome orientation is required: EV must align probabilities via
// `orientation` before comparing — unverified orientation → no-match (null).
// ---------------------------------------------------------------------------

export const marketMatches = pgTable(
  "market_matches",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    polymarketId: text("polymarket_id").notNull(),
    normalizedId: bigint("normalized_id", { mode: "number" })
      .notNull()
      .references(() => marketsNormalized.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    /** PM outcome this match is for (e.g. "yes", team id, outcome label). */
    pmOutcome: text("pm_outcome").notNull(),
    /** Matched platform's corresponding outcome label. */
    contributorOutcome: text("contributor_outcome").notNull(),
    /** `same` = contributor YES ≡ PM YES; `inverted` = contributor YES ≡ PM NO. */
    orientation: text("orientation").notNull(),
    confidenceTier: text("confidence_tier").notNull(),
    score: real("score").notNull(),
    matchMethod: text("match_method").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    unique("market_matches_polymarket_normalized_unique").on(
      table.polymarketId,
      table.normalizedId,
    ),
    index("market_matches_polymarket_id_idx").on(table.polymarketId),
    index("market_matches_expires_at_idx").on(table.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// ev_snapshots — computed EV over time per Polymarket market
// Intentionally NO FK to market_matches / markets_normalized — keyed by
// polymarket_id (text) only so historical snapshots survive match row deletes.
// ---------------------------------------------------------------------------

export const evSnapshots = pgTable(
  "ev_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    polymarketId: text("polymarket_id").notNull(),
    polymarketProb: numeric("polymarket_prob").notNull(),
    consensusProb: numeric("consensus_prob").notNull(),
    gap: numeric("gap").notNull(),
    signal: text("signal").notNull(),
    contributors: jsonb("contributors").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("ev_snapshots_polymarket_created_idx").on(
      table.polymarketId,
      table.createdAt.desc(),
    ),
  ],
);

// ---------------------------------------------------------------------------
// sync_runs — ingest/match job observability (freshness alarms, health row)
// ---------------------------------------------------------------------------

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scope: text("scope").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", {
      withTimezone: true,
      mode: "date",
    }),
    status: text("status").notNull(),
    counts: jsonb("counts").$type<SyncRunCounts>(),
    error: text("error"),
    /** Keyed by platform id → freshness / row-count snapshot. */
    perPlatform: jsonb("per_platform").$type<
      Record<string, SyncPlatformHealth>
    >(),
  },
  (table) => [
    index("sync_runs_scope_started_idx").on(
      table.scope,
      table.startedAt.desc(),
    ),
    index("sync_runs_status_idx").on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------

export type MarketsRaw = typeof marketsRaw.$inferSelect;
export type MarketsRawInsert = typeof marketsRaw.$inferInsert;

export type MarketsNormalized = typeof marketsNormalized.$inferSelect;
export type MarketsNormalizedInsert = typeof marketsNormalized.$inferInsert;

export type MarketMatch = typeof marketMatches.$inferSelect;
export type MarketMatchInsert = typeof marketMatches.$inferInsert;

export type EvSnapshot = typeof evSnapshots.$inferSelect;
export type EvSnapshotInsert = typeof evSnapshots.$inferInsert;

export type SyncRun = typeof syncRuns.$inferSelect;
export type SyncRunInsert = typeof syncRuns.$inferInsert;

// ---------------------------------------------------------------------------
// Phase 2 — EV pipeline (PM ↔ Kalshi mappings, p_true, trader analytics)
// Complements market_matches (multi-platform normalized graph) with direct
// bilateral links keyed by polymarket_token_id + kalshi_ticker for hot paths.
// ---------------------------------------------------------------------------

export const MARKET_MAPPING_METHODS = [
  "deterministic",
  "string",
  "vector",
  "llm",
  "manual",
  "token_boost",
  "token_heuristic",
  "TEST_FALLBACK_PAIR",
] as const;
export type MarketMappingMethod = (typeof MARKET_MAPPING_METHODS)[number];

export const PROBABILITY_SOURCE_TYPES = [
  "ensemble",
  "llm",
  "cross_market",
  "manual",
] as const;
export type ProbabilitySourceType = (typeof PROBABILITY_SOURCE_TYPES)[number];

export const TRADER_EV_PLATFORMS = ["polymarket", "kalshi", "all"] as const;
export type TraderEvPlatform = (typeof TRADER_EV_PLATFORMS)[number];

export const TRADER_EV_PERIODS = ["live", "daily", "all_time"] as const;
export type TraderEvPeriod = (typeof TRADER_EV_PERIODS)[number];

/** Audit trail for ensemble / LLM contributors to p_true. */
export interface TrueProbabilityContributor {
  source: string;
  weight: number;
  p: number;
  variance?: number;
}

export interface TraderEvBreakdown {
  /** Mean EV per closed trade (probability space, e.g. 0.03 = +3¢ edge). */
  meanTradeEv?: number;
  /** Sum of per-trade EV × stake. */
  weightedEvUsd?: number;
  /** Positions with positive EV at entry. */
  positiveEvCount?: number;
  /** Positions with negative EV at entry. */
  negativeEvCount?: number;
}

export const marketMappings = pgTable(
  "market_mappings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Polymarket CLOB token id (primary hot-path key). */
    polymarketTokenId: text("polymarket_token_id").notNull(),
    /** Optional condition id for market-level joins. */
    polymarketConditionId: text("polymarket_condition_id"),
    kalshiTicker: text("kalshi_ticker").notNull(),
    /** 0–1 match confidence (string, vector cosine, or LLM score). */
    confidenceScore: real("confidence_score").notNull(),
    matchMethod: text("match_method").notNull(),
    /** Cosine similarity when match_method = vector. */
    embeddingSimilarity: real("embedding_similarity"),
    /** PM outcome label this mapping applies to. */
    pmOutcome: text("pm_outcome"),
    /** Kalshi outcome side (yes/no or contract label). */
    kalshiOutcome: text("kalshi_outcome"),
    /** same | inverted — required before EV comparison. */
    orientation: text("orientation").notNull().default("same"),
    /** Optional link back to normalized match graph. */
    marketMatchId: bigint("market_match_id", { mode: "number" }).references(
      () => marketMatches.id,
      { onDelete: "set null" },
    ),
    verifiedAt: timestamp("verified_at", {
      withTimezone: true,
      mode: "date",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("market_mappings_pm_token_kalshi_unique").on(
      table.polymarketTokenId,
      table.kalshiTicker,
    ),
    index("market_mappings_kalshi_ticker_idx").on(table.kalshiTicker),
    index("market_mappings_confidence_idx").on(table.confidenceScore.desc()),
    index("market_mappings_expires_at_idx").on(table.expiresAt),
  ],
);

export const trueProbabilities = pgTable(
  "true_probabilities",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    mappingId: bigint("mapping_id", { mode: "number" }).references(
      () => marketMappings.id,
      { onDelete: "set null" },
    ),
    polymarketTokenId: text("polymarket_token_id").notNull(),
    kalshiTicker: text("kalshi_ticker"),
    /** AI / ensemble estimate of true probability p ∈ [0, 1]. */
    pTrue: numeric("p_true").notNull(),
    /** Model confidence or LLM self-score ∈ [0, 1]. */
    sourceScore: numeric("source_score"),
    /** Epistemic variance of p_true estimate. */
    variance: numeric("variance"),
    sourceType: text("source_type").notNull(),
    modelVersion: text("model_version"),
    contributors: jsonb("contributors")
      .$type<TrueProbabilityContributor[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    calculatedAt: timestamp("calculated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("true_probabilities_polymarket_token_id_unique").on(
      table.polymarketTokenId,
    ),
    index("true_probabilities_pm_token_calculated_idx").on(
      table.polymarketTokenId,
      table.calculatedAt.desc(),
    ),
    index("true_probabilities_mapping_calculated_idx").on(
      table.mappingId,
      table.calculatedAt.desc(),
    ),
  ],
);

export const traderEvAnalytics = pgTable(
  "trader_ev_analytics",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Lowercase proxy wallet (Polymarket) or account id. */
    wallet: text("wallet").notNull(),
    platform: text("platform").notNull(),
    period: text("period").notNull(),
    /** Mean EV per trade (edge in probability units). */
    averageEv: numeric("average_ev"),
    /** Cumulative portfolio EV (USD-weighted). */
    totalPortfolioEv: numeric("total_portfolio_ev"),
    tradeCount: bigint("trade_count", { mode: "number" }).notNull().default(0),
    closedTradeCount: bigint("closed_trade_count", { mode: "number" })
      .notNull()
      .default(0),
    breakdown: jsonb("breakdown").$type<TraderEvBreakdown>(),
    calculatedAt: timestamp("calculated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("trader_ev_analytics_wallet_platform_period_unique").on(
      table.wallet,
      table.platform,
      table.period,
    ),
    index("trader_ev_analytics_wallet_updated_idx").on(
      table.wallet,
      table.updatedAt.desc(),
    ),
    index("trader_ev_analytics_average_ev_idx").on(table.averageEv.desc()),
  ],
);

export type MarketMapping = typeof marketMappings.$inferSelect;
export type MarketMappingInsert = typeof marketMappings.$inferInsert;

export type TrueProbability = typeof trueProbabilities.$inferSelect;
export type TrueProbabilityInsert = typeof trueProbabilities.$inferInsert;

export type TraderEvAnalytic = typeof traderEvAnalytics.$inferSelect;
export type TraderEvAnalyticInsert = typeof traderEvAnalytics.$inferInsert;

// ---------------------------------------------------------------------------
// X Detection Engine — whale registry, post queue, gate audit log
// ---------------------------------------------------------------------------

/** Known whale wallets tracked for X post eligibility and copy generation. */
export const whaleRegistry = pgTable("whale_registry", {
  /** Lowercase proxy wallet or platform account id. */
  walletAddress: text("wallet_address").primaryKey(),
  pseudonym: text("pseudonym").notNull(),
  resolvedBetsCount: integer("resolved_bets_count").notNull().default(0),
  /** Raw EV decimal (e.g. 0.12 = +12%). */
  avgEv: real("avg_ev").notNull().default(0),
  /** Win rate decimal (e.g. 0.65 = 65%). */
  winRate: real("win_rate").notNull().default(0),
  avgStakeNotional: real("avg_stake_notional").notNull().default(0),
  postedCount30d: integer("posted_count_30d").notNull().default(0),
  /** pending | complete | failed — distinguishes unhydrated defaults from computed stats. */
  hydrationStatus: text("hydration_status").notNull().default("pending"),
  hydratedAt: timestamp("hydrated_at", { withTimezone: true, mode: "date" }),
  lastHydrationAttemptAt: timestamp("last_hydration_attempt_at", {
    withTimezone: true,
    mode: "date",
  }),
  hydrationError: text("hydration_error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
});

/** Human-in-the-loop queue for whale trade X posts awaiting review/dispatch. */
export const xPostQueue = pgTable(
  "x_post_queue",
  {
    /** App-generated CUID/UUID. */
    id: text("id").primaryKey(),
    walletAddress: text("wallet_address")
      .notNull()
      .references(() => whaleRegistry.walletAddress, { onDelete: "cascade" }),
    tradeId: text("trade_id").notNull(),
    templateFamily: text("template_family").notNull(),
    variantId: text("variant_id"),
    evGloss: text("ev_gloss"),
    copyText: text("copy_text").notNull(),
    marketSlug: text("market_slug").notNull(),
    side: text("side").notNull(),
    entryCents: real("entry_cents").notNull(),
    nowCents: real("now_cents").notNull(),
    stakeNotional: real("stake_notional").notNull(),
    status: text("status").notNull().default("PENDING_REVIEW"),
    reviewToken: text("review_token").notNull(),
    scheduledFor: timestamp("scheduled_for", {
      withTimezone: true,
      mode: "date",
    }),
    /** X tweet id after successful publish (TradePost.xTweetId). */
    xTweetId: text("x_tweet_id"),
    /** X media id after receipt image upload (v1.uploadMedia). */
    xMediaId: text("x_media_id"),
    /** Optional hosted receipt preview URL (nullable). */
    receiptMediaUrl: text("receipt_media_url"),
    /** Public channel message id from PUBLIC_TELEGRAM_BOT on publish. */
    publicTelegramMessageId: text("public_telegram_message_id"),
    /** Cofounder email/name who accepted or rejected the draft. */
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", {
      withTimezone: true,
      mode: "date",
    }),
    dispatchedAt: timestamp("dispatched_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** Incremented on each failed X publish attempt. */
    publishRetryCount: integer("publish_retry_count").notNull().default(0),
    /** Last X/Telegram publish error (truncated). */
    lastPublishError: text("last_publish_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("x_post_queue_trade_id_unique").on(table.tradeId),
    unique("x_post_queue_review_token_unique").on(table.reviewToken),
    index("x_post_queue_status_scheduled_idx").on(
      table.status,
      table.scheduledFor,
    ),
    index("x_post_queue_wallet_created_idx").on(
      table.walletAddress,
      table.createdAt.desc(),
    ),
  ],
);

/**
 * Internal shadow log for Kalshi trades — not eligible for public X posting.
 * Keyed on Kalshi `trade_id` (per execution). Do not join to whale_registry or
 * synthesize trader identity columns — see docs/Kalshi Whale Attribution Audit.md.
 *
 * Postgres columns (snake_case):
 * trade_id, ticker, size, traded_at, entry_price, taker_side, taker_outcome_side,
 * taker_book_side, is_block_trade, usd_notional, raw_payload, created_at
 */
export const kalshiShadowTrades = pgTable(
  "kalshi_shadow_trades",
  {
    /** Kalshi trade_id from the API stream. */
    tradeId: text("trade_id").primaryKey(),
    ticker: text("ticker").notNull(),
    size: doublePrecision("size").notNull(),
    tradedAt: timestamp("traded_at", { withTimezone: true, mode: "date" }).notNull(),
    entryPrice: doublePrecision("entry_price").notNull(),
    takerSide: text("taker_side"),
    takerOutcomeSide: text("taker_outcome_side"),
    takerBookSide: text("taker_book_side"),
    isBlockTrade: boolean("is_block_trade").notNull().default(false),
    usdNotional: doublePrecision("usd_notional"),
    category: text("category"),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("kalshi_shadow_trades_ticker_traded_at_idx").on(
      table.ticker,
      table.tradedAt.desc(),
    ),
    index("kalshi_shadow_trades_category_traded_at_idx").on(
      table.category,
      table.tradedAt.desc(),
    ),
  ],
);

export const xPostRejectionReasonEnum = pgEnum(
  "rejection_reason",
  X_POST_REJECTION_REASONS,
);

/** Append-only audit log for X post gate decisions per trade. */
export const xPostLog = pgTable(
  "x_post_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tradeId: text("trade_id").notNull(),
    gatePassed: boolean("gate_passed").notNull(),
    rejectionReason: xPostRejectionReasonEnum("rejection_reason"),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("x_post_log_trade_id_created_idx").on(
      table.tradeId,
      table.createdAt.desc(),
    ),
    index("x_post_log_gate_passed_created_idx").on(
      table.gatePassed,
      table.createdAt.desc(),
    ),
  ],
);

/**
 * Product-feed history — backs the non-empty-feed fallback for /api/feed only.
 * Not read by the X post queue or approval pipeline.
 *
 * `averageEv` is percent units (3 = +3%), matching MIN_FEED_TRADE_EV_PCT.
 */
export const feedTrades = pgTable(
  "feed_trades",
  {
    tradeId: text("trade_id").primaryKey(),
    transactionHash: text("transaction_hash"),
    proxyWallet: text("proxy_wallet"),
    title: text("title").notNull(),
    stakeAmount: doublePrecision("stake_amount").notNull(),
    averageEv: doublePrecision("average_ev").notNull(),
    category: text("category"),
    tradedAt: timestamp("traded_at", { withTimezone: true, mode: "date" }).notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("feed_trades_fallback_idx").on(
      table.stakeAmount,
      table.averageEv,
      table.tradedAt.desc(),
    ),
    index("feed_trades_category_traded_at_idx").on(
      table.category,
      table.tradedAt.desc(),
    ),
  ],
);

export type WhaleRegistry = typeof whaleRegistry.$inferSelect;
export type WhaleRegistryInsert = typeof whaleRegistry.$inferInsert;

export type XPostQueue = typeof xPostQueue.$inferSelect;
export type XPostQueueInsert = typeof xPostQueue.$inferInsert;

export type XPostLog = typeof xPostLog.$inferSelect;
export type XPostLogInsert = typeof xPostLog.$inferInsert;

export type KalshiShadowTrade = typeof kalshiShadowTrades.$inferSelect;
export type KalshiShadowTradeInsert = typeof kalshiShadowTrades.$inferInsert;

export type FeedTrade = typeof feedTrades.$inferSelect;
export type FeedTradeInsert = typeof feedTrades.$inferInsert;

// ---------------------------------------------------------------------------
// feed_daily_metrics — durable daily feed trust-layer counters by venue
// ---------------------------------------------------------------------------

export const FEED_METRICS_VENUES = ["polymarket", "kalshi"] as const;
export type FeedMetricsVenue = (typeof FEED_METRICS_VENUES)[number];

/** UTC day key (YYYY-MM-DD) + venue aggregate counters for feed trust metrics. */
export const feedDailyMetrics = pgTable(
  "feed_daily_metrics",
  {
    dayKey: text("day_key").notNull(),
    venue: text("venue").notNull(),
    tradesDetected: integer("trades_detected").notNull().default(0),
    gatePassedTrades: integer("gate_passed_trades").notNull().default(0),
    distinctWhales: integer("distinct_whales").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("feed_daily_metrics_day_venue_unique").on(table.dayKey, table.venue),
    index("feed_daily_metrics_day_key_idx").on(table.dayKey.desc()),
  ],
);

/** Qualified wallet membership for correct daily distinct-whale counts. */
export const feedDailyQualifiedWhales = pgTable(
  "feed_daily_qualified_whales",
  {
    dayKey: text("day_key").notNull(),
    venue: text("venue").notNull(),
    wallet: text("wallet").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("feed_daily_qualified_whales_day_venue_wallet_unique").on(
      table.dayKey,
      table.venue,
      table.wallet,
    ),
    index("feed_daily_qualified_whales_day_venue_idx").on(
      table.dayKey,
      table.venue,
    ),
  ],
);

export type FeedDailyMetrics = typeof feedDailyMetrics.$inferSelect;
export type FeedDailyMetricsInsert = typeof feedDailyMetrics.$inferInsert;

export type FeedDailyQualifiedWhale =
  typeof feedDailyQualifiedWhales.$inferSelect;
export type FeedDailyQualifiedWhaleInsert =
  typeof feedDailyQualifiedWhales.$inferInsert;

// ---------------------------------------------------------------------------
// Phase 2E wallet history — shadow/indexed metrics (NOT production whale_registry)
// ---------------------------------------------------------------------------

export const walletLedgerEvents = pgTable(
  "wallet_ledger_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    walletAddress: text("wallet_address").notNull(),
    chainId: text("chain_id").notNull().default("137"),
    dedupeKey: text("dedupe_key").notNull(),
    canonicalIdentity: text("canonical_identity"),
    txHash: text("tx_hash"),
    logIndex: text("log_index"),
    blockNumber: bigint("block_number", { mode: "number" }),
    blockTimestamp: bigint("block_timestamp", { mode: "number" }),
    contractAddress: text("contract_address"),
    eventType: text("event_type").notNull(),
    marketConditionId: text("market_condition_id"),
    assetId: text("asset_id"),
    side: text("side"),
    shares: doublePrecision("shares"),
    cashUsd: doublePrecision("cash_usd"),
    price: doublePrecision("price"),
    source: text("source").notNull(),
    ledgerVersion: text("ledger_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("wallet_ledger_events_wallet_dedupe_unique").on(
      table.walletAddress,
      table.dedupeKey
    ),
    index("wallet_ledger_events_wallet_idx").on(table.walletAddress),
    index("wallet_ledger_events_wallet_block_idx").on(
      table.walletAddress,
      table.blockNumber
    ),
    index("wallet_ledger_events_wallet_block_id_idx").on(
      table.walletAddress,
      table.blockNumber,
      table.id
    ),
    index("wallet_ledger_events_wallet_canonical_idx").on(
      table.walletAddress,
      table.canonicalIdentity
    ),
    // Partial unique: one canonical chain log per wallet perspective (cross-wallet shared fills allowed).
    // Applied via migration 0029; Drizzle schema uses uniqueIndex for partial indexes in raw SQL migrations.
  ]
);

export const walletPositionLifecycles = pgTable(
  "wallet_position_lifecycles",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    walletAddress: text("wallet_address").notNull(),
    conditionId: text("condition_id").notNull(),
    assetId: text("asset_id").notNull(),
    metricVersion: text("metric_version").notNull(),
    lifecycleEpisode: integer("lifecycle_episode").notNull().default(0),
    completed: boolean("completed").notNull().default(false),
    completionType: text("completion_type"),
    capitalAtRisk: doublePrecision("capital_at_risk").notNull().default(0),
    buyNotional: doublePrecision("buy_notional").notNull().default(0),
    sellNotional: doublePrecision("sell_notional").notNull().default(0),
    resolutionPayout: doublePrecision("resolution_payout").notNull().default(0),
    realizedPnl: doublePrecision("realized_pnl"),
    realizedRoi: doublePrecision("realized_roi"),
    profitable: boolean("profitable"),
    outcomeWin: boolean("outcome_win"),
    openedAt: bigint("opened_at", { mode: "number" }),
    completedAt: bigint("completed_at", { mode: "number" }),
    exclusionReason: text("exclusion_reason"),
    resolutionSource: text("resolution_source"),
    resolutionFinal: boolean("resolution_final"),
    calculatedAt: timestamp("calculated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("wallet_position_lifecycles_position_version_unique").on(
      table.walletAddress,
      table.conditionId,
      table.assetId,
      table.metricVersion,
      table.lifecycleEpisode
    ),
    index("wallet_position_lifecycles_wallet_idx").on(table.walletAddress),
  ]
);

export const walletHistoricalMetrics = pgTable(
  "wallet_historical_metrics",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    walletAddress: text("wallet_address").notNull(),
    metricVersion: text("metric_version").notNull(),
    completedPositions: integer("completed_positions").notNull().default(0),
    medianCapitalAtRisk: doublePrecision("median_capital_at_risk"),
    resolvedVolumeUsd: doublePrecision("resolved_volume_usd"),
    profitablePositionRate: doublePrecision("profitable_position_rate"),
    outcomeWinRate: doublePrecision("outcome_win_rate"),
    realizedRoi: doublePrecision("realized_roi"),
    credibilityMetricsValid: boolean("credibility_metrics_valid")
      .notNull()
      .default(false),
    credibilityDecision: boolean("credibility_decision").notNull().default(false),
    historyValidity: text("history_validity").notNull(),
    historyComplete: boolean("history_complete").notNull().default(false),
    credibilityReasons: jsonb("credibility_reasons").$type<string[]>().default([]),
    historyIncompleteReasons: jsonb("history_incomplete_reasons")
      .$type<string[]>()
      .default([]),
    throughBlock: bigint("through_block", { mode: "number" }),
    calculatedAt: timestamp("calculated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("wallet_historical_metrics_wallet_version_unique").on(
      table.walletAddress,
      table.metricVersion
    ),
    index("wallet_historical_metrics_wallet_idx").on(table.walletAddress),
  ]
);

export const walletHistoryCoverage = pgTable(
  "wallet_history_coverage",
  {
    walletAddress: text("wallet_address").primaryKey(),
    chainId: text("chain_id").notNull().default("137"),
    provider: text("provider").notNull(),
    fromBlock: bigint("from_block", { mode: "number" }).notNull(),
    lastIndexedBlock: bigint("last_indexed_block", { mode: "number" }).notNull(),
    lastReconstructedBlock: bigint("last_reconstructed_block", {
      mode: "number",
    }).notNull(),
    apiOldestTimestamp: bigint("api_oldest_timestamp", { mode: "number" }),
    indexedOldestTimestamp: bigint("indexed_oldest_timestamp", { mode: "number" }),
    extendsBeforeApiBoundary: boolean("extends_before_api_boundary")
      .notNull()
      .default(false),
    eventsBeforeApiBoundary: integer("events_before_api_boundary")
      .notNull()
      .default(0),
    eventHistoryComplete: boolean("event_history_complete").notNull().default(false),
    identityComplete: boolean("identity_complete").notNull().default(false),
    resolutionComplete: boolean("resolution_complete").notNull().default(false),
    historyComplete: boolean("history_complete").notNull().default(false),
    historyValidity: text("history_validity").notNull(),
    timestampCoveragePct: doublePrecision("timestamp_coverage_pct"),
    timestampMissingBlocks: integer("timestamp_missing_blocks"),
    gammaResolutionIncomplete: boolean("gamma_resolution_incomplete")
      .notNull()
      .default(false),
    mergeSplitUnresolved: boolean("merge_split_unresolved")
      .notNull()
      .default(false),
    metricVersion: text("metric_version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  }
);

export const walletShadowBatchStatus = pgTable(
  "wallet_shadow_batch_status",
  {
    batchId: text("batch_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    status: text("status").notNull().default("pending"),
    cohortReason: text("cohort_reason"),
    errorMessage: text("error_message"),
    performance: jsonb("performance").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("wallet_shadow_batch_status_batch_wallet_unique").on(
      table.batchId,
      table.walletAddress
    ),
    index("wallet_shadow_batch_status_batch_idx").on(table.batchId),
  ]
);

export const walletShadowResults = pgTable(
  "wallet_shadow_results",
  {
    batchId: text("batch_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    label: text("label"),
    cohortReason: text("cohort_reason"),
    executionStatus: text("execution_status").notNull(),
    historyValidity: text("history_validity").notNull(),
    historyComplete: boolean("history_complete").notNull().default(false),
    credibilityMetricsValid: boolean("credibility_metrics_valid")
      .notNull()
      .default(false),
    productionDecision: boolean("production_decision"),
    productionReasons: jsonb("production_reasons").$type<string[]>().default([]),
    productionMetricsSnapshot: jsonb("production_metrics_snapshot").$type<
      Record<string, unknown>
    >(),
    apiReconstructedDecision: boolean("api_reconstructed_decision"),
    apiReasons: jsonb("api_reasons").$type<string[]>().default([]),
    apiMetricsSnapshot: jsonb("api_metrics_snapshot").$type<
      Record<string, unknown>
    >(),
    indexedDecision: boolean("indexed_decision").notNull().default(false),
    indexedReasons: jsonb("indexed_reasons").$type<string[]>().default([]),
    indexedMetricsSnapshot: jsonb("indexed_metrics_snapshot").$type<
      Record<string, unknown>
    >(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}),
    comparisonMetadataMissing: boolean("comparison_metadata_missing")
      .notNull()
      .default(false),
    productionObservationSource: text("production_observation_source"),
    apiObservationSource: text("api_observation_source"),
    indexedObservationSource: text("indexed_observation_source"),
    metricVersion: text("metric_version"),
    queryPlanVersion: text("query_plan_version"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true, mode: "date" }),
    performance: jsonb("performance").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("wallet_shadow_results_batch_wallet_unique").on(
      table.batchId,
      table.walletAddress
    ),
    index("wallet_shadow_results_batch_idx").on(table.batchId),
  ]
);

// Policy A coverage shadow — observational only, not production gates
export const policyAShadowTradeObservations = pgTable(
  "policy_a_shadow_trade_observations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tradeId: text("trade_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    tradedAt: timestamp("traded_at", { withTimezone: true, mode: "date" }),
    source: text("source").notNull().default("polymarket_feed"),
    stakeUsd: doublePrecision("stake_usd"),
    tradeEvPercent: doublePrecision("trade_ev_percent"),
    translationValid: boolean("translation_valid"),
    productionWalletPass: boolean("production_wallet_pass"),
    productionHydrationState: text("production_hydration_state"),
    indexedDataValidityDecision: text("indexed_data_validity_decision"),
    historicalPerformanceDecision: text("historical_performance_decision"),
    historicalPerformanceFailureReasons: jsonb("historical_performance_failure_reasons")
      .$type<string[]>()
      .default([]),
    historicalPerformancePolicyVersion: text("historical_performance_policy_version"),
    feedVisible: boolean("feed_visible").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("policy_a_shadow_observed_at_idx").on(table.observedAt.desc()),
    index("policy_a_shadow_wallet_idx").on(table.walletAddress),
    unique("policy_a_shadow_trade_source_unique").on(table.tradeId, table.source),
  ]
);

export const policyACoverageDailyMetrics = pgTable(
  "policy_a_coverage_daily_metrics",
  {
    dayKey: text("day_key").notNull(),
    venue: text("venue").notNull().default("polymarket"),
    tradesDetected: integer("trades_detected").notNull().default(0),
    tradeGateQualified: integer("trade_gate_qualified").notNull().default(0),
    productionWalletQualified: integer("production_wallet_qualified")
      .notNull()
      .default(0),
    policyAPass: integer("policy_a_pass").notNull().default(0),
    policyAFail: integer("policy_a_fail").notNull().default(0),
    policyAUnknown: integer("policy_a_unknown").notNull().default(0),
    feedVisible: integer("feed_visible").notNull().default(0),
    feedWouldRemainPolicyA: integer("feed_would_remain_policy_a")
      .notNull()
      .default(0),
    feedWouldFailPolicyA: integer("feed_would_fail_policy_a").notNull().default(0),
    feedUnknownPolicyA: integer("feed_unknown_policy_a").notNull().default(0),
    distinctProductionWallets: integer("distinct_production_wallets")
      .notNull()
      .default(0),
    distinctPolicyAPassWallets: integer("distinct_policy_a_pass_wallets")
      .notNull()
      .default(0),
    distinctPolicyAFailWallets: integer("distinct_policy_a_fail_wallets")
      .notNull()
      .default(0),
    distinctPolicyAUnknownWallets: integer("distinct_policy_a_unknown_wallets")
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.dayKey, table.venue] }),
    index("policy_a_coverage_daily_day_idx").on(table.dayKey.desc()),
  ]
);

export const policyAProductionWalletHydration = pgTable(
  "policy_a_production_wallet_hydration",
  {
    walletAddress: text("wallet_address").primaryKey(),
    priorityTier: integer("priority_tier").notNull(),
    status: text("status").notNull().default("pending"),
    lastAttemptAt: timestamp("last_attempt_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastError: text("last_error"),
    completedPositions: integer("completed_positions"),
    historyValidity: text("history_validity"),
    policyADecision: text("policy_a_decision"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("policy_a_hydration_status_tier_idx").on(
      table.status,
      table.priorityTier
    ),
  ]
);

export type PolicyAShadowTradeObservation =
  typeof policyAShadowTradeObservations.$inferSelect;
export type PolicyACoverageDailyMetrics =
  typeof policyACoverageDailyMetrics.$inferSelect;
export type PolicyAProductionWalletHydration =
  typeof policyAProductionWalletHydration.$inferSelect;

export type WalletLedgerEventRow = typeof walletLedgerEvents.$inferSelect;
export type WalletPositionLifecycleRow = typeof walletPositionLifecycles.$inferSelect;
export type WalletHistoricalMetricRow = typeof walletHistoricalMetrics.$inferSelect;
export type WalletHistoryCoverageRow = typeof walletHistoryCoverage.$inferSelect;
export type WalletShadowBatchStatusRow = typeof walletShadowBatchStatus.$inferSelect;
export type WalletShadowResultRow = typeof walletShadowResults.$inferSelect;
