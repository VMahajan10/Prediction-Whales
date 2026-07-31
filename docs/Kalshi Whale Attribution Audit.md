# Kalshi Whale Attribution Audit (PRD Issue 4 / OQ-2)

**Date:** 2026-07-31  
**Status:** Resolved — **not attributable; ToS prohibits cross-member whale profiling**  
**Recommendation:** **Reduced Card** in product feed; **Exclude** from X agent pipeline (already implemented)

---

## Executive summary

Kalshi’s public trade APIs and WebSocket `trade` channel expose **per-execution** identifiers (`trade_id`) and market mechanics only. They do **not** expose any persistent member, wallet, user hash, or account key that links multiple trades to the same counterparty.

Private authenticated channels (`fill`, `portfolio/fills`) expose `order_id` / `fill_id`, but only for **the authenticated member’s own** executions — not for third-party whale attribution.

Kalshi’s **Developer Agreement v1.1** and **Data Terms of Service** prohibit using API/website data to aggregate, store, profile, or share other members’ trading activity for third-party analytics products. Whale wallet profiling is therefore **not technically possible** via public schemas and **not policy-compliant** even if attempted via inference.

---

## 1. API schema check

### 1.1 Our integration (codebase)

| Surface | File(s) | Auth | Notes |
|--------|---------|------|-------|
| REST `GET /trade-api/v2/markets/trades` | `lib/kalshiTrades.ts`, `app/api/kalshi/trades/route.ts` | None | Poll every ~4s client-side (`lib/useKalshiTrades.ts`, `POLL_MS = 4000`) |
| Trade detail / market enrich | `lib/kalshiDetail.ts`, `app/api/kalshi/trade-detail/route.ts` | None | Uses same public trade fields |
| Kalshi WebSocket | — | — | **Not integrated.** Live feed is REST poll only; Polymarket uses WS |
| Shadow log | `lib/x-agent/kalshiShadowTrades.ts`, `kalshi_shadow_trades` table | N/A | Dedupes on `trade_id` (per trade, not per trader) |
| X agent | `lib/x-agent/postQueueGates.ts` | N/A | `KALSHI_PUBLIC_POSTING_DISABLED` — Kalshi never queued for public X posts |

**`KalshiRawTrade` fields we parse** (`lib/kalshiTrades.ts`):

- `trade_id` — UUID, unique per matched execution
- `ticker` — market identifier
- `count_fp`, `yes_price_dollars`, `no_price_dollars` — size and price
- `taker_side` / `taker_outcome_side` / `taker_book_side` — direction
- `created_time`, `is_block_trade`

**Not present in our types or Kalshi public schemas:** `user_id`, `member_id`, `account_id`, `wallet`, `subtrader_id`, `order_id` (maker/taker), or any hashed identity.

`traceable: true` on Kalshi `FeedTrade` rows means “trade detail page exists,” **not** “wallet-attributable.” Kalshi trades have no `proxyWallet`; the X agent falls back to `ANONYMOUS_WALLET_ADDRESS` when enqueued.

### 1.2 Kalshi official schemas (REST + WebSocket)

#### Public trade stream — `GET /markets/trades` + WS `trade` channel

Sources: [Get Trades](https://docs.kalshi.com/api-reference/market/get-trades), [Public Trades WS](https://docs.kalshi.com/websockets/public-trades)

| Field | Scope | Persistent across trades? |
|-------|-------|---------------------------|
| `trade_id` | Single execution | **No** — one UUID per fill/match event |
| `market_ticker` | Market | N/A (market-level) |
| `count_fp`, prices | Execution | N/A |
| `taker_outcome_side`, `taker_book_side` | Taker direction | N/A (direction only, not identity) |
| `is_block_trade` | Execution type | N/A |
| `created_time` / `ts_ms` | Timestamp | N/A |

**Verdict:** No cross-trade trader identity in public market data.

#### Private fill stream — WS `fill` + `GET /portfolio/fills`

Sources: [User Fills WS](https://docs.kalshi.com/websockets/user-fills), [Get Fills](https://docs.kalshi.com/api-reference/portfolio/get-fills)

| Field | Scope | Usable for third-party whale attribution? |
|-------|-------|-------------------------------------------|
| `trade_id` / `fill_id` | Own fill | **No** — scoped to authenticated member |
| `order_id` | Own order | **No** — per-order, own account only |
| `subaccount_number` | Own subaccount | **No** — own account partitioning only |

**Verdict:** Identity fields exist only for **self**; cannot attribute other members’ trades.

#### Orderbook delta — WS `orderbook_delta`

Source: [Orderbook Updates](https://docs.kalshi.com/websockets/orderbook-updates)

`client_order_id` and `subaccount` appear **only when the authenticated subscriber caused the change** (“Present only when you caused this orderbook change”). No counterparty identity for other participants.

#### FCM endpoints

`GET /fcm/orders` and `GET /fcm/positions` filter by **subtrader ID** but require **FCM member access** and return data for subtraders under that FCM — not a public whale-tracking surface.

### 1.3 Could we infer identity?

Theoretically one could attempt behavioral fingerprinting (timing, size patterns, market selection). That would be:

1. **Unreliable** — no stable public key to validate linkage across sessions
2. **Prohibited** — Developer Agreement §3.6 (“Attempting to access data belonging to other members”) and Data ToS bans on systematic retrieval / database compilation for third-party use

---

## 2. Policy & ToS check

### 2.1 Kalshi Developer Agreement v1.1

Source: [Kalshi Developer Agreement (PDF)](https://assets.kalshi.com/Kalshi-Developer-Agreement.pdf)

Relevant prohibitions for whale attribution / analytics products:

| Section | Restriction | Impact on whale attribution |
|---------|-------------|----------------------------|
| **§3 (intro)** | API use limited to **facilitating a member’s own trading** | Whale-tracking product is out of scope |
| **§3.1** | No collecting/caching/aggregating/storing API data except for own trading; no sharing with third parties without written authorization | Blocks building a whale feed DB (`kalshi_shadow_trades`, feed cards) for end users without Kalshi approval |
| **§3.5** | No benchmarking or competitive monitoring of Kalshi services | Analytics product risk |
| **§3.6** | No accessing **other members’** data | Direct blocker on cross-wallet profiling |

### 2.2 Kalshi Data Terms of Service

Source: [Kalshi Data ToS (PDF)](https://kalshi-public-docs.s3.amazonaws.com/kalshi-data-terms-of-service.pdf)

- Prohibits scraping, systematic retrieval, compiling databases/directories, and “text and data mining” on Kalshi Data
- Prohibits use of Kalshi Data for ML/AI training without authorization
- Applies to data accessed via the website **or otherwise** (includes public API responses)

### 2.3 Regulatory / product context (PRD)

The PRD correctly notes Kalshi is **CFTC-regulated** and structurally does not expose trader identity in public market data — consistent with regulated exchange privacy norms. Our UI already states this in `components/KalshiMarketFlowPanel.tsx` (`KalshiAnonymousTradePanel`).

### 2.4 Rate limits (operational, not attribution)

Source: [Rate Limits and Tiers](https://docs.kalshi.com/getting_started/rate_limits)

- `GET /markets/trades` costs 10 tokens (default); Basic tier = 200 read tokens/s sustained (~20 req/s)
- Our ~4s poll + 1.5s server cache is well within limits
- Sub-15s refresh is feasible for **market-level** trade detection; irrelevant for **trader-level** attribution since no ID exists

---

## 3. Architectural decision matrix

### 3.1 Decision: **NOT attributable & NOT compliant for whale profiling**

| Path | Verdict | Rationale |
|------|---------|-----------|
| **(a) Full whale card** (pseudonym, win rate, avg EV, profile link) | ❌ **Do not ship** | No persistent public ID; credibility gate (PRD §2.1) impossible; ToS blocks cross-member profiling |
| **(b) Reduced card** (market, side, stake, entry/now, no whale row) | ✅ **Recommended for product feed** | Delivers “large flow on Kalshi” signal without false attribution; aligns with existing anonymous trade detail UI |
| **(c) Exclude from X agent** | ✅ **Recommended — already done** | `KALSHI_PUBLIC_POSTING_DISABLED` in `postQueueGates.ts`; shadow log only via `kalshi_shadow_trades` |
| **(d) Exclude Kalshi entirely from app** | ⚠️ Optional | Loses cross-platform feed value; only needed if legal wants zero Kalshi data aggregation |

### 3.2 `kalshi_shadow_trades` — correct keying

**Do not add a `trader_id` or synthetic wallet column.** The only stable identifier from the public API is `trade_id` (per execution). Current schema is correct:

```text
PRIMARY KEY (trade_id)  -- execution handle, NOT a member identity
```

Use this table for:

- Internal shadow P&L experiments on anonymous large flows
- Market-level flow analytics (per `ticker`)
- Deduping poll/notify replays

Do **not** use it for:

- Whale registry joins
- Win-rate / avg EV credibility gates
- X post queue / template `{whale}` / `{win_rate}` fields

### 3.3 Implementation checklist (post-audit)

| Area | Current state | Action |
|------|---------------|--------|
| X agent post queue | Kalshi blocked | ✅ No change |
| `kalshi_shadow_trades` | Trade-level only | ✅ No change |
| Product whale feed cards | May still show whale UI affordances | **Use Reduced Card** — hide whale strip, win rate, avg EV, profile link for `source === "kalshi"` |
| Trade detail | Anonymous panel exists | ✅ Keep `KalshiAnonymousTradePanel` |
| `notifyKalshiFeedTradeIfEligible` | Still fires tweet path with `whaleAddress: "Anonymous"` | **Disable or gate** if public Kalshi whale tweets violate product positioning |
| OQ-2 in PRD | Open | Mark **Resolved** → Reduced Card + X Exclude |

---

## 4. References

- Kalshi REST trades: https://docs.kalshi.com/api-reference/market/get-trades
- Kalshi WS public trades: https://docs.kalshi.com/websockets/public-trades
- Kalshi WS user fills: https://docs.kalshi.com/websockets/user-fills
- Kalshi portfolio fills: https://docs.kalshi.com/api-reference/portfolio/get-fills
- Kalshi Developer Agreement v1.1: https://assets.kalshi.com/Kalshi-Developer-Agreement.pdf
- Kalshi Data ToS: https://kalshi-public-docs.s3.amazonaws.com/kalshi-data-terms-of-service.pdf
- Internal: `docs/Prediction Whales — PRD.md` (§2.2 OQ-2, §2.1 credibility gate)
