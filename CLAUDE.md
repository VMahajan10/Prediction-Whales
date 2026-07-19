# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MarketPulse — a Next.js 14 (App Router) app that surfaces prediction-market whale trades, cross-platform expected value (EV), and arbitrage opportunities across Polymarket, Kalshi, Manifold, and Metaculus (plus sportsbook consensus via The Odds API). Ships to web (Vercel) and wrapped as a mobile app via Capacitor (`ios/`, `android/`), where the native shell just loads the deployed Vercel URL (see `capacitor.config.ts` — remote-shell pattern, not a bundled local build).

## Commands

```bash
npm run dev              # Next.js dev server
npm run dev:all          # dev server + triggers the EV pipeline cron once against localhost

npm run build && npm start
npm run lint

# Database (Drizzle + Postgres/pgvector, schema at lib/crossmarket/store/schema.ts)
npm run db:generate      # generate migration from schema changes
npm run db:migrate       # apply migrations
npm run db:studio        # Drizzle Studio

# Mobile shell
npm run cap:sync
npm run cap:ios / npm run cap:android
```

### Tests

There is no Jest/Vitest runner — tests are plain scripts executed directly with `tsx` and asserted with `node:assert/strict`. Run a single suite directly, e.g.:

```bash
npx tsx --tsconfig tsconfig.json lib/evPipeline/phase0Phase1.test.ts
npx tsx --tsconfig tsconfig.json lib/arbitrageFinder/phase04.test.ts
```

or via the matching `npm run test:*` / `npm run test:arb-*` script (see `package.json`). Each file prints `✓`/`✗` per case and exits non-zero on failure. `scripts/*.ts` are one-off diagnostic/backfill tools (also run with `npx tsx --tsconfig tsconfig.json scripts/<name>.ts`), not part of the automated suite — e.g. `report:pipeline-coverage`, `report:arb-coverage`, `flush:ev-cache`, `backfill:ptrue`.

### Environment

Copy `.env.local.example` → `.env.local`. Key vars: `DATABASE_URL` (Postgres+pgvector), `CRON_SECRET` (auth for the pipeline cron), `OPENAI_API_KEY`/`PROBABILITY_LLM_MODEL`, `KALSHI_KEY_ID`/`KALSHI_PRIVATE_KEY`, `UPSTASH_REDIS_REST_URL`/`TOKEN`, `ODDS_API_KEY` (optional, sportsbook consensus). Many pipeline/DB features degrade gracefully (`isDatabaseEnabled()` checks) rather than hard-failing when unset.

## Architecture

### Two parallel EV/arbitrage systems

The codebase has two somewhat independent subsystems that both compute "is this trade/market mispriced" — don't conflate them:

1. **`lib/evPipeline/*`** — the cross-platform EV pipeline. Ingests order books from Polymarket/Kalshi, matches equivalent markets across platforms (string → vector embedding → LLM fallback, persisted to `market_mappings`), computes an ensemble "true probability" (`p_true`) per market from multiple contributors (RAG/news sentiment, baseline models, cross-platform consensus — see `lib/ai/probabilityEngine.ts` and `lib/evPipeline/ensemblePTrue.ts`/`pTrueEnsembleResolver.ts`), and derives trade-level EV (`lib/finance/evEngine.ts`) against that p_true. Orchestrated end-to-end by `runEvPipeline()` in `lib/evPipeline/pipeline.ts`.
2. **`lib/arbitrageFinder/*` + `lib/finance/arbitrageEngine.ts`** — pure cross-venue arbitrage detection: given synchronized order books for a mapped pair (one leg YES on venue A, opposing leg on venue B), computes whether the combined cost of a fully-hedged position is under 100% (a locked-in profit window), sizes stakes (`stakeOptimizer.ts`, `arbitrageStakeMath.ts`), and caches scan results (`cache/windowCache.ts`). Entry point is `scanArbitrageWindows*` in `windowScanner.ts` / `windowService.ts`, re-exported through `lib/arbitrageFinder/index.ts` as the package's public surface.

Both subsystems depend on the same market-mapping/order-book plumbing but answer different questions (EV = "is this trade priced wrong vs. modeled truth"; arbitrage = "can I lock in profit right now regardless of truth").

### Pipeline orchestration (`lib/evPipeline/pipeline.ts`)

`runEvPipeline()` runs six sequential stages, each independently error-isolated (a stage failure doesn't throw — it returns `{ ok: false, error }` and the run continues), with a final `sync_runs` row recording status/counts:

1. `ingestOrderBooks` — cache PM/Kalshi order-book mids in Redis (short TTL)
2. `matchMarkets` — cross-platform market matching → upsert `market_mappings`; result feeds `activeMatchedPairs`, a module-level list consumed by every later stage in the same run
3. `refreshConsensusIndexStage` — rebuild sportsbook consensus + prop-level alias keys
4. `ingestRagContextStage` — warm the similar-market RAG index + seed odds history
5. `computePTrue` — ensemble true-probability computation → `true_probabilities` table + Redis cache
6. `computeTraderEv` — per-trade/wallet EV lookup cache

Triggered by `GET /api/cron/ev-pipeline` (Vercel Cron or manual with `Authorization: Bearer $CRON_SECRET`), guarded by a Redis-based run lock (`acquirePipelineLock`/`releasePipelineLock`) so overlapping cron ticks 409 instead of racing.

### Data layer

- Postgres (pgvector-enabled) via Drizzle, single schema file `lib/crossmarket/store/schema.ts`. Notable tables: `markets_raw` (per-platform ingestion), `market_mappings` (cross-platform pair matches with confidence tier: `direct`/`correlated`/`proxy`), `true_probabilities`, `trader_ev_analytics`, `sync_runs`.
- Upstash Redis is the hot path for anything read on every request (order-book mids, p_true, arb scan windows, pipeline locks/meta) — see `lib/evPipeline/redisCache.ts` and `lib/arbitrageFinder/cache/windowCache.ts`. Falls back to an in-process `globalThis` map (`initGlobalLocalEvCache`) when Redis is unavailable, so pipeline writes and API reads stay consistent within one server instance even without Redis configured.
- `lib/crossmarket/platforms/*` — per-platform raw market fetchers (`kalshi.ts`, `manifold.ts`, `metaculus.ts`) behind a common `PLATFORM_REGISTRY` (`registry.ts`), each tagged with a tier and a `reliability` weight used downstream in ensemble weighting.

### API routes (`app/api/*`)

Thin route handlers that call into `lib/*` — business logic lives in `lib`, not in route files. Notable groups: `/api/cron/ev-pipeline` (orchestrator above), `/api/ev/*` (EV pipeline reads: map-markets, arbitrage, trades, trader), `/api/arbitrage/*` (arbitrage scan/display/windows/coverage), `/api/kalshi/*` (Kalshi passthrough/detail/enrich), `/api/cross-market-ev/*`, `/api/whale*` (whale wallet trade tracking/profiles).

### Frontend

App Router pages under `app/*` (markets, trades, traders, whales, portfolio, following, alerts) wrapped by `app/providers.tsx`: `DemoAuthGate` (demo/auth gating) → `PolymarketSocketProvider` (live PM websocket feed context). `lib/hooks/*` and top-level `lib/use*.ts` files are the client-side data hooks (live feed, whale alerts, arbitrage scan/display, cross-market EV index) that components consume — check for an existing hook before adding a new data-fetching pattern.

### Path aliases

`@/*` → repo root, `@kalshi/sdk` → `lib/kalshi-sdk` (see `tsconfig.json`). `lib/crossmarket/**` and `scripts/**` are excluded from the main tsconfig's type-checked set (they're still run via `tsx`, which is not part of `tsc`).
