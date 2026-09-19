# Credibility Metric Contract v2 (Phase 2E.2 Stage A)

**Status:** Stage A definition only — no live gate changes.  
**Contract ID:** `credibility-metric-contract-v2`  
**Batch calibration:** `tmp/wallet-history/phase2e2-stageA-wallet-calibration.json`

---

## 1. Four distinct shadow comparators

| Code | Semantic name | Legacy field(s) | Role |
|------|---------------|-----------------|------|
| **A** | `productionCredibilityDecision` | `productionDecision`, `productionCredible` | Production numeric credibility (`whale_registry` + hydration) |
| **B** | `apiReconstructedDecision` | `apiReconstructedDecision` | Legacy diagnostic: truncated public API history |
| **C** | `indexedDataValidityDecision` | `indexedDecision`, `credibilityDecision`, `credibilityMetricsValid` | **Structural / data-quality validity only** |
| **D** | `indexedCredibilityCandidateDecision` | *(none yet)* | Phase 2E.2 candidate indexed credibility |

### C rename (reporting)

Do **not** describe C as “indexed credibility PASS/FAIL.”

Preferred labels:

- `indexedDataValidity` / `indexedDataValidityDecision`
- `indexedMetricsSafe` (execution outcome: metrics computable)

C answers: *“Is indexed history structurally sound enough to compute wallet metrics?”*

C does **not** answer: *“Does this wallet meet product credibility thresholds?”*

Implementation alias module: `lib/walletLedger/indexed/credibilityContractV2.ts`

---

## 2. Candidate D — two-layer contract

```
D = indexedDataValidityDecision
    AND sufficientHistoricalEvidence
    AND historicalPerformanceQualification
    [AND optional capitalVolumeQualification]
```

### Layer 1 — Data validity (frozen)

```
layer1 = indexedDataValidityDecision == true
```

Equivalent to current C. **Semantics unchanged in Stage A.**

Source: `assessWalletLedgerValidity()` → `credibilityMetricsValid`  
(`lib/walletLedger/validity.ts`)

Blocks: truncation, identity unresolved/ambiguous/low-confidence, no history events, backfill required, held-completed missing gamma finality, material merge/split ambiguity (≥5% completed).

### Layer 2 — Numeric credibility (Stage A: defined, thresholds unresolved)

Only evaluated when Layer 1 passes.

| Sub-requirement | Status | Notes |
|-----------------|--------|-------|
| `sufficientHistoricalEvidence` | **candidate** | Initial experience metric: `completedPositionCount` |
| `historicalPerformanceQualification` | **unresolved** | No canonical metric/threshold selected |
| `capitalVolumeQualification` | **unresolved** | Optional; no auto-mapped $300 rule |

---

## 3. Resolved experience metric

### Production: `resolved_bets_count`

| Property | Value |
|----------|-------|
| **Source** | Polymarket Data API closed positions → `whale_registry.resolved_bets_count` |
| **Formula** | Count of positions after filters in `closedPositionsToResolvedBets()` |
| **Filters** | Non-ephemeral; `entryPrice > 0`; **`realizedPnl !== 0`** |
| **Window** | API-returned closed-position history (truncation possible) |
| **Production analog threshold** | `>= 10` (`MIN_WALLET_RESOLVED_BETS`) — **approved for production only** |
| **Semantic compatibility with indexed** | **No** |

### Indexed: `completed_position_count`

| Property | Value |
|----------|-------|
| **Source** | On-chain lifecycle reconstruction → `wallet_historical_metrics.completed_positions` |
| **Formula** | `buildMetricBundle(positions, credibleFilter).completedPositionCount` |
| **Filter (`credibleFilter`)** | `completed && !excludedFromMetrics && realizedPnl != null && (fully_exited \|\| resolution.resolutionFinal)` |
| **Window** | Full indexed chain history (subject to identity/coverage) |
| **Stage A candidate floor** | `>= 10` — **observational only** |
| **Production-equivalent?** | **Not declared** until lifecycle semantics approved |

### Semantic differences (summary)

| Dimension | Production | Indexed |
|-----------|------------|---------|
| Data source | Polymarket API | On-chain events + Gamma |
| Zero-PnL positions | Excluded | Included if completed with `realizedPnl != null` |
| Completion rule | API “closed” | Lifecycle: fully exited OR gamma-final resolution |
| Truncation | API window | Indexed extends-before-API immunity when proven |
| Grouping | Per API position | Per condition/asset lifecycle |

**Report column rename:** use `indexedCompletedPositionCount` (not “indexed positions”).

---

## 4. Profitability metrics — no AVG EV substitution

### Production `avg_ev` (wallet gate)

```
avg_ev = (1/N) Σ (payout - entry) / entry
```

where `payout ∈ {0,1}` from sign of `realizedPnl`.  
**Outcome-derived; structurally suspect as “EV.”**  
Threshold in production: `>= 0.03` (approved for A only).

### Indexed profitability bundle (reporting / Stage B input)

| Metric | Formula | Unit | In D gate? |
|--------|---------|------|------------|
| `portfolioRealizedRoi` | `totalRealizedPnl / totalCapitalAtRisk` | decimal ROI | **unresolved** |
| `profitablePositionRate` | profitable completed / completed | rate [0,1] | **unresolved** |
| `outcomeWinRate` | held-through-resolution wins / held resolved | rate [0,1] | **unresolved** |
| `totalRealizedPnl` | sum of position PnL | USD | reporting only |
| `avgEv` in indexed bundle | always `null` | — | **not used** |

**Explicit prohibition (Stage A):**

> Do **not** define `portfolioRealizedRoi >= 0.03` as indexed replacement for `avg_ev >= 0.03`.

Stage A reports distributions and exploratory cuts only (labeled **EXPLORATORY ONLY**).

---

## 5. Ex-ante EV vs wallet historical credibility

| Concept | Scope | Current home |
|---------|-------|--------------|
| **Wallet historical credibility** | Lifetime track record | Production A (`resolved_bets`, `avg_ev`) |
| **Trade ex-ante EV** | Single trade vs model truth | EV pipeline / `p_true` / trade-level gates |

**Product-contract recommendation (Stage A only):**

Future credibility should likely be:

```
credible historical track record  +  qualifying current trade EV
```

rather than:

```
historical "AVG EV" (outcome-derived misnomer)
```

Do **not** reuse outcome-derived historical metrics under the name AVG EV in indexed contract D.

---

## 6. Capital / volume metrics

| Production | Indexed |
|------------|---------|
| `avg_stake_notional` (registry) | `medianCapitalAtRisk` |
| Proxy: `resolved_bets_count × avg_stake_notional` | `resolvedVolumeUsd` (= sum capital at risk on credible completed) |

**Not numerically equivalent.** Do not auto-apply legacy `$300` proxy to indexed.

Stage A: report distributions (min, P10, P25, median, P75, P90, max) split by production PASS / FAIL / UNKNOWN for metrics-safe wallets.

---

## 7. Field specification table (candidate D inputs)

| Field | Formula | Source | Unit | Window | Min data | Biases | Production analog | Compatible? | Threshold |
|-------|---------|--------|------|--------|----------|--------|-------------------|-------------|-----------|
| `indexedDataValidityDecision` | `credibilityMetricsValid` | `validity.ts` | bool | lifetime indexed | events + identity | gamma/merge/identity | hydration + structure | partial | **approved (as C)** |
| `completedPositionCount` | credible-filter count | lifecycle reconstruction | count | lifetime | Layer 1 | stricter than API | `resolved_bets_count` | **no** | **candidate (≥10)** |
| `portfolioRealizedRoi` | Σpnl / ΣCAR | lifecycle | decimal | lifetime | completed positions | scale with CAR | none direct | **no** | **unresolved** |
| `profitablePositionRate` | profitable / completed | lifecycle | rate | lifetime | completed | ignores magnitude | `winRate` (different) | **no** | **unresolved** |
| `outcomeWinRate` | outcome correct / held resolved | lifecycle + gamma | rate | lifetime | held resolved | needs resolution | none | **no** | **unresolved** |
| `medianCapitalAtRisk` | median position CAR | lifecycle | USD | lifetime | completed | per-position not per-trade | `avg_stake_notional` | **no** | **unresolved** |
| `resolvedVolumeUsd` | Σ capital at risk | lifecycle | USD | lifetime | completed | not stake×count proxy | proxy volume | **no** | **unresolved** |
| `productionResolvedBets` | API filtered count | whale_registry | count | API window | hydration | truncation, PnL≠0 filter | self | — | **approved (≥10)** |
| `productionAvgEv` | outcome ROI mean | whale_registry | decimal | API window | ≥1 bet | misnamed EV | self | — | **approved (≥0.03)** |

---

## 8. Count disagreement taxonomy

| Category | Rule (Stage A) |
|----------|----------------|
| `PRODUCTION_UNDERCOUNT` | indexed − production ≥ 3 |
| `INDEXED_LOWER_COUNT` | production − indexed ≥ 3 |
| `ROUGH_AGREEMENT` | \|delta\| < 3 |
| `UNUSABLE_NOT_COMPARABLE` | unusable history or missing counts |

Explain with: API truncation, `realizedPnl != 0`, lifecycle filter, identity, gamma/finality.

---

## 9. Stage B scope (proposed)

1. **Approve or reject** `completedPositionCount >= 10` as `sufficientHistoricalEvidence`
2. **Select** `historicalPerformanceQualification` metric(s) — not ROI-as-AVG-EV
3. **Decide** fate of production `avg_ev` in wallet credibility vs trade-only EV
4. **Decide** whether capital metrics enter D
5. **Implement** D evaluator (shadow-only) without changing C or production
6. **Re-run** shadow comparison A vs D on full50 (no re-audit if persisted metrics suffice)

---

## 10. Stage B outcomes (Phase 2E.2)

See `tmp/wallet-history/phase2e2-stageB-analysis.json` and component evaluator
`lib/walletLedger/indexed/credibilityCandidateV2.ts`.

- **D is component-based** — `overallDecision` stays `UNKNOWN` until performance policy is approved.
- **Experience candidate:** `completedPositionCount >= 10` (shadow only).
- **Verdict:** POSITION-lifecycle measure ≠ BET-equivalent `resolved_bets_count`.
- **avg_ev:** recommend DEPRECATE from wallet credibility; keep trade-level ex-ante EV separate.
- **Capital:** reporting-only at Stage B.


- Production gate: `lib/walletLedger/indexed/shadow/productionProbe.ts`, `lib/x-agent/walletCredibility.ts`
- Indexed validity (C): `lib/walletLedger/validity.ts`, `lib/walletLedger/indexed/indexedCredibility.ts`
- Semantic aliases: `lib/walletLedger/indexed/credibilityContractV2.ts`
- Calibration script: `scripts/phase2e2-stageA-calibration.ts`
