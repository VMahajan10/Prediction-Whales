import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  jsonb,
  numeric,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  unique,
  customType,
} from "drizzle-orm/pg-core";

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
