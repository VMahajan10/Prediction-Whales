# Phase 2E.1 persistence (shadow-only)

Isolated Postgres tables — **not** wired to production `whale_registry` credibility gate.

Migration: `drizzle/0022_wallet_history_phase2e1.sql`  
Metric version: `WALLET_METRIC_VERSION = phase2e1-v1` (`lib/walletLedger/indexed/metricVersion.ts`)

## Tables

### `wallet_ledger_events`
Normalized indexed events; idempotent upsert on `dedupe_key`. Rebuilds `WalletLedgerEvent`.

### `wallet_position_lifecycles`
Per `(wallet, condition_id, asset_id, metric_version)` lifecycle outputs (CAR, PnL, ROI, completion).

### `wallet_historical_metrics`
One row per `(wallet, metric_version)` — indexed credibility decision + metrics bundle + reason codes.

### `wallet_history_coverage`
Coverage diagnostics including `timestamp_coverage_pct`, `timestamp_missing_blocks`,
`timestamp_known_failed_blocks`, API boundary fields, `history_validity`.

### `wallet_shadow_batch_status`
Resumable batch execution (`pending` / `running` / `complete` / `failed` / `unusable`).

## Persistence API

`lib/walletLedger/indexed/store/persistWalletHistory.ts`:
- `persistIndexedWalletAudit()` — events + lifecycles + metrics + coverage
- `getWalletHistoryIntegrityReport()` — row counts + duplicate `dedupe_key` check
- `countWalletLedgerEvents()` — per-wallet event count for idempotency verification

## Authoritative baseline vs incremental persistence

`wallet_ledger_events` stores **chain authoritative events only** — never API-only rows.

Two modes (`lib/walletLedger/indexed/store/authoritativePersistence.ts`):

1. **baseline_repair** — when reconstructed authoritative identities are missing from DB,
   insert every missing chain event (ON CONFLICT DO NOTHING) and enrich metadata.
   `lastIndexedBlock` is **not** proof of baseline completeness.
2. **incremental** — only after baseline is proven complete (`authoritativeEventsMissingAfter = 0`),
   persist newly indexed delta identities.

Post-persist validation uses a frozen per-run snapshot
(`.cache/wallet-validation-snapshots/`) of API + gamma inputs so replay matches audit
metrics exactly. Before Policy A production enforcement, durable metric snapshots should
also retain a versioned hash of API-only inputs used for the verdict (not required for
shadow hydration once baseline persistence is correct).

## Incremental refresh (Phase 2E.1)

1. Checkpoint gap-only Etherscan fetch (`resumeCheckpoint: true`) — no full refetch from block 57M
2. Persist missing authoritative chain events (baseline repair) or delta only (incremental)
3. Rebuild lifecycles from full persisted event set (acceptable for 2E.1; cost measured per wallet)
4. Refresh metrics + coverage

DB is durable source; checkpoint files remain transport/recovery state.

## Timestamp negative cache

`lib/walletLedger/indexed/blockTimestampFailures.ts` — TTL/backoff per failed block
(replaces permanent `failed.json`). Coverage fields on `blockTimestampStats` and
`wallet_history_coverage` — **not** part of credibility formula.

## Shadow comparison

```bash
npm run shadow:credibility-compare              # Stage A: 10 wallets
npm run shadow:credibility-compare -- --stage full50 --concurrency 3  # Stage B (prepare only)
```

Reports: `tmp/wallet-history/shadow-compare/{batchId}.json` + `.md`

Scripts require `import "./preload-env"` (or equivalent) for `server-only` bypass.
