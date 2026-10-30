# Wallet ledger vs Polymarket reconciliation (forensic)

**Date:** 2026-10-18  
**Script:** `scripts/reconcile-polymarket-vs-ledger.ts`  
**PF logic:** unchanged pending reconciliation (ledger-only PF remains gated on this work).

## Summary

The Polymarket **closed-positions** Data API and our **indexed ledger** are measuring **different populations and scales** for the same proxy wallet. The contradiction is **not** explained by “50-row truncation” alone:

| Source | Wallet 1 (`0xe907…cff6`) |
|--------|---------------------------|
| Polymarket profile **Total PnL** | **−$7.9M** ([profile](https://polymarket.com/@0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6)) |
| Closed-positions API (50 rows, sum of `realizedPnl`) | **+$8.42M** (all 50 rows positive) |
| Ledger completed lifecycles (net) | **−$129.6k** (GP $128.8k / GL $258.4k) |

Profile PnL and ledger net are both negative but **~60× apart**. The closed-positions sum is **opposite sign** and **~65× larger** than ledger gross profit — it is **not** a valid cross-check for total wallet PnL.

## Indexing coverage (all three test wallets)

| Wallet | `from_block` | `last_indexed_block` | `through_block` (metrics) | `history_complete` | `history_incomplete_reasons` |
|--------|--------------|----------------------|---------------------------|--------------------|------------------------------|
| `0xe907…cff6` | 57,000,000 | 93,759,853 | 93,759,853 | false | `gamma_resolution_incomplete` |
| `0x9e3ed7…f882` | 57,000,000 | 93,371,050 | 93,371,050 | false | `gamma_resolution_incomplete` |
| `0xad529d…11ac` | (see DB) | (see DB) | (see DB) | false | `activity_truncated`, `trades_truncated`, `gamma_resolution_incomplete`, `merge_split_unresolved` |

Provider: `etherscan_v2`, chain `137`. Metrics `calculated_at` lags coverage `updated_at` (e.g. wallet 1 metrics **2026-09-14** vs coverage **2026-10-17**).

## Polymarket profile Total PnL vs ledger net

| Wallet | Profile Total PnL | Ledger net (GP − GL) | Δ (profile − ledger) |
|--------|-------------------|----------------------|----------------------|
| `0xe907…cff6` (suntori) | **−$7.9M** | **−$129.6k** | ~−$7.77M |
| `0x9e3ed7…f882` | **−$2.7M** | **−$19.9k** | ~−$2.68M |
| `0xad529d…11ac` (SaturnStormCube) | **+$44.5k** | **+$2.88k** | ~+$41.6k |

Ledger is **not** within a reasonable margin of Polymarket profile PnL for any wallet. Do **not** treat ledger PF as validated against Polymarket until ingestion/accounting gaps are closed.

## Wallet 1 — top 10 closed-positions API vs `wallet_position_lifecycles`

Sorted by |`realizedPnl`|. Match key: `asset` (API) = `asset_id` (ledger).

| # | Market (API title) | API `realizedPnl` | Ledger rows | Ledger completed PnL sum | Status |
|---|-------------------|-------------------|-------------|-------------------------|--------|
| 1 | Spain 2026 FIFA World Cup | $416,068 | 1 | $0 (`completed: false`) | **PNL_MISMATCH** — ledger shows ~$3.1k buy / $1.1k sell vs API $1.82M `totalBought` |
| 2 | Brazil win 2026-06-29 | $398,797 | 0 | — | **MISSING_IN_LEDGER** |
| 3 | Lincoln tennis | $311,274 | 0 | — | **MISSING_IN_LEDGER** |
| 4 | England win 2026-07-05 | $309,363 | 0 | — | **MISSING_IN_LEDGER** |
| 5 | Morocco win 2026-07-04 | $242,406 | 0 | — | **MISSING_IN_LEDGER** |
| 6 | United States win 2026-06-12 | $238,385 | 0 | — | **MISSING_IN_LEDGER** |
| 7 | Norway win 2026-06-30 | $228,033 | 0 | — | **MISSING_IN_LEDGER** |
| 8 | Spain win 2026-07-10 | $227,388 | 0 | — | **MISSING_IN_LEDGER** |
| 9 | Norway win 2026-06-22 | $220,074 | 0 | — | **MISSING_IN_LEDGER** |
| 10 | Exact score Spain 2–1 Belgium | $219,273 | 0 | — | **MISSING_IN_LEDGER** |

**49 / 50** unique API assets have **no** lifecycle row at all.

### Likely causes (ranked)

1. **Incomplete lifecycle completion** — Rows that exist often have `completed: false`, `realized_pnl: null`, and small `buy_notional` / `sell_notional` vs API `totalBought` in the millions → on-chain/event reconstruction is not attributing the same volume to this wallet+asset.
2. **History / resolution gaps** — `gamma_resolution_incomplete` (all wallets); wallet 3 also `activity_truncated`, `trades_truncated`, `merge_split_unresolved` → many positions never reach `completed` with final PnL in ledger.
3. **Not missing block range for wallet 1** — Indexing runs through block **93.7M**; API timestamps on top positions are **2026-06..07** (in-universe). Missing rows are not explained by “indexing stopped before 2026” alone; events are missing or not mapped per asset.
4. **Closed-positions API semantics** — The 50 returned rows are **all winners** (sum +$8.4M); they are **not** full closed history and **not** profile Total PnL (−$7.9M). Do not sum this endpoint for wallet-level reconciliation.
5. **Identity** — API uses `proxyWallet` matching our wallet address; mismatch with funder/neg-risk is still worth auditing for specific markets but does not explain 49/50 absent `asset_id` rows if proxy is correct elsewhere.

## Known gaps (product / engineering)

- Ledger `completed_positions` in metrics (e.g. 1537) ≠ raw completed lifecycle count (2240) — metric bundle uses credibility filters.
- Many lifecycles show `opened_at` **1970-01-01** (missing block timestamp) on wallets 2–3.
- Gamma title lookups for category PF capped at 120 condition IDs per hydration.

## Wallet 1 — Spain World Cup (`condition_id` `0x7976…2892`)

| Source | Notional / scale |
|--------|------------------|
| API closed position | `totalBought` **$1,816,858.96**, `realizedPnl` **$416,068.34** |
| `wallet_ledger_events` (350 events, same condition + asset) | `sum(cash_usd)` **$4,219.99** |
| `wallet_position_lifecycles` (1 row) | `buy_notional` **~$3,129**, `sell_notional` **~$1,091**, `completed: false`, `realized_pnl: null` |

Ledger events exist for this market but capture **~0.2%** of API-reported bought notional.

## Persistence (timestamp patch timeout)

`patchPersistedEventTimestamps` no longer runs one `UPDATE` per block (which scanned huge row sets and hit `DbQueryTimeoutError` at ~120s). It now backfills via batched `UPDATE … FROM (VALUES …)` on `(wallet_address, dedupe_key)` — same path as metadata enrichment, **1,500 rows per statement**, idempotent (`block_timestamp IS NULL` only). Index: `wallet_ledger_events_wallet_dedupe_null_ts_idx` (partial, null timestamps). Inserts use **1,000-row** chunks (`ON CONFLICT DO NOTHING` on `wallet_address, dedupe_key`).

`EXPLAIN` on the dedupe-key patch uses `wallet_ledger_events_wallet_dedupe_unique` (Index Scan on wallet + dedupe_key).

## Volume capture fix (neg-risk OrderFilled)

Neg-risk exchange fills pair USDC asset id `0` with a full ERC-1155 token id, or compact id `1` with the full token id. The ledger normalizer previously treated only id `0` as USDC, dropping or misclassifying most neg-risk legs (e.g. Spain WC ~$1.82M `totalBought` vs ~$3k indexed BUY cash).

Indexer query plan now includes **Neg Risk CTF Exchange**, **CTF v1/v2/legacy**, and **Neg Risk Adapter** split/merge/convert/redemption topics for the proxy wallet (maker + taker).

Re-verify Spain after full re-index:

`npx tsx --tsconfig tsconfig.json scripts/reindex-wallet1-spain-verify.ts`

## UI / PF gate

Ledger-derived stats (PF, PnL, win rate, CLV) are hidden until `NEXT_PUBLIC_LEDGER_STATS_VERIFIED=1`, set only after integration reconciliation passes:

`WALLET_LEDGER_RECONCILIATION_TEST=1 npx vitest run tests/walletLedger/polymarketLedgerReconciliation.test.ts`

## Next steps (before trusting ledger PF)

1. Expand event attribution for high-volume markets (why 350 events sum to $4.2k vs $1.8M API `totalBought`).
2. Trace why high-volume markets never get a lifecycle row (ingestion filter, dedupe, Class D, merge/split).
3. Close `gamma_resolution_incomplete` and truncation flags; re-run lifecycle persist.
4. Define a single **ground-truth** PnL source (profile Total PnL or full closed-positions export) and automated tolerance test.
