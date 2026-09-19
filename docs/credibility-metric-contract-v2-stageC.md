# Credibility Metric Contract v2 — Stage C (Expanded Calibration)

**Status:** Stage C calibration study (`phase2e2-stageC-v1`) — shadow-only.  
**Study version:** `phase2e2-stageC-v1`  
**Candidate contract version:** `credibility-metric-contract-v2-stageC`  
**Ledger metric version:** `phase2e1-v1` (unchanged)  
**Artifacts:** `tmp/wallet-history/phase2e2-stageC-*.json|md`

---

## 1. Product semantics approved (experience)

### `completedPositionCount`

**Term:** completed historical trading positions

**Not:** resolved bets

A completed historical position qualifies when:

- position is **completed**
- **not** `excludedFromMetrics`
- `realizedPnl != null`
- `fully_exited` **OR** `resolutionFinal == true`

**`fully_exited` before market resolution counts** as historical trading experience: the trader completed the lifecycle and realized an economic result.

### Non-equivalence to production

`completedPositionCount` is **NOT** semantically equivalent to production `resolved_bets_count`.

- Do **not** silently replace or rename the DB field `resolved_bets_count`.
- Production continues to use API closed-position semantics (`realizedPnl !== 0` filter, truncation, etc.).

### Candidate experience rule (shadow only)

```
historicalEvidence PASS when completedPositionCount >= 10
```

Production `MIN_WALLET_RESOLVED_BETS` remains unchanged.

---

## 2. avg_ev deprecation (conceptual — no production change)

Production historical `avg_ev` is **outcome-derived**:

```
mean((payout - entry) / entry)
```

It is **not** genuine ex-ante expected value.

**D contract direction:**

| Layer | Metric |
|-------|--------|
| Wallet historical performance (D) | **Historical realized performance** (`portfolioRealizedRoi`, `profitablePositionRate`) |
| Current-trade qualification | **Ex-ante trade EV** (unchanged) |

Future product model:

```
credible trader history + qualifying current trade EV
```

No production code change in Stage C.

---

## 3. Performance metric — NOT frozen in Stage C

Stage B had only **11** wallets with `indexedDataValidity=true` AND `completedPositionCount>=10` — insufficient for threshold selection.

**Candidate shortlist (exploratory):**

- A. `portfolioRealizedRoi`
- B. `profitablePositionRate`
- C. Combination

**D component state during Stage C:**

| Component | Value |
|-----------|-------|
| `dataValidity` | defined (= C) |
| `historicalEvidence` | candidate defined (floor 10, shadow) |
| `historicalPerformance` | **UNKNOWN** |
| `capitalQualification` | **NOT_USED** |
| `overallDecision` | **UNKNOWN** unless earlier layer FAILs |

Do **not** persist a canonical D PASS until `historicalPerformance` is approved.

---

## 4. Expanded calibration cohort

**Study:** `phase2e2-stageC-v1`  
**Manifest:** `tmp/wallet-history/phase2e2-stageC-cohort.json` (frozen before execution)

**Target:** ~100 wallets with `indexedDataValidity=true` AND `completedPositionCount>=10`  
**Cohort size:** 220 wallets (stratified; sized from registry eligibility)

**Stratification:**

| Dimension | Buckets |
|-----------|---------|
| Production gate | PASS / FAIL / UNKNOWN |
| Registry history | low resolved / medium / capped_50 / unknown hydration |
| Anchors | full50 wallets, known disagreement class |

**Execution constraints (unchanged):**

- Reuse `wallet_historical_metrics`, `wallet_history_coverage`, `wallet_ledger_events`, Etherscan checkpoints
- Incremental chain delta only
- `concurrency = 2`, 8GB heap, keyset loading, circuit breakers, journal resumability

---

## 5. Stage C analysis outputs

Script: `scripts/phase2e2-stageC-analysis.ts`

| Output | Content |
|--------|---------|
| ROI / rate distributions | N, min, P10, P25, median, P75, P90, max, mean, stdDev |
| Correlations | Spearman ROI↔rate, ROI↔count, rate↔count, ROI↔volume, rate↔volume |
| Sample-size buckets | 10–19, 20–49, 50–99, 100+ completed |
| Archetypes | CONSISTENT_WINNER, HIGH_WIN_RATE_NEGATIVE_RETURN, LOW_WIN_RATE_POSITIVE_RETURN, CONSISTENT_LOSER |
| Policy matrix | Exploratory ROI/rate/combination thresholds vs production A (comparator, not ground truth) |
| Robustness | Experience floors 10 / 20 / 50 |
| Quality review | Extreme ROI wallets — CAR, volume, jackpot artifact, exclusions |

**Capital:** `medianCapitalAtRisk`, `resolvedVolumeUsd` recorded; **not** in D.

---

## 6. Live shadow — deferred

Do **not** start 48–72h live production shadow until expanded offline analysis recommends a `historicalPerformance` definition.

**Stage C → Stage D path:**

1. Complete expanded offline calibration  
2. Freeze D contract (if exit criteria met)  
3. Live shadow  
4. Migration readiness

---

## 7. Stage C exit criteria

May recommend freezing D only if:

| Criterion | Requirement |
|-----------|-------------|
| A | ≥ ~100 eligible wallets (validity + completed≥10) |
| B | Lifecycle metrics structurally valid |
| C | ROI/rate interpretable across sample-size buckets |
| D | Performance metric/policy has defensible product semantics |
| E | Threshold not chosen merely to match production A |

Otherwise: **`NEEDS_MORE_DATA`**

---

## 8. Commands

```bash
# Build cohort manifest (before batch)
npx tsx --tsconfig tsconfig.json scripts/phase2e2-stageC-cohort.ts

# Run shadow audits (resumable)
NODE_OPTIONS="--max-old-space-size=8192" npx tsx --tsconfig tsconfig.json \
  scripts/shadow-credibility-compare.ts --stage stageC --concurrency 2

# Offline analysis (after metrics persisted)
npx tsx --tsconfig tsconfig.json scripts/phase2e2-stageC-analysis.ts
```

---

## 9. References

- Base contract: `docs/credibility-metric-contract-v2.md`
- Stage B analysis: `tmp/wallet-history/phase2e2-stageB-analysis.json`
- Component evaluator: `lib/walletLedger/indexed/credibilityCandidateV2.ts`
- Cohort builder: `lib/walletLedger/indexed/shadow/cohortStageC.ts`
