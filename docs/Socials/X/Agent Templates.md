## Variable schema 

| Slot             | Example                                                  | Source                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{whale}`        | "the Zhang-match whale" / pseudonym / short wallet alias | Wallet registry (we name recurring whales; never raw wallet addresses)                                                                                                                                               |
| `{win_rate}`     | 68%                                                      | Wallet history, resolved markets only                                                                                                                                                                                |
| `{avg_ev}`       | +12%                                                     | Wallet history: AVG (payout − entry)/entry across resolved bets. <br><br>Preferred credibility stat: EV outranks win rate (*60% WR at +10% EV beats 89% WR at −5% EV*). Always pair using plain-English translation. |
| `{resolved}`     | 1,240                                                    | Wallet history                                                                                                                                                                                                       |
| `{stake}`        | $52K                                                     | Trade                                                                                                                                                                                                                |
| `{avg_stake}`    | ~$8K                                                     | Wallet stake-history: rolling average stake across recent resolved bets; skip the template  if unavailable.                                                                                                          |
| `{side}`         | "Zhizhen Zhang" / "Chelsea" / "Newsom"                   | Market translation layer — named side, never YES/NO on a ticker                                                                                                                                                      |
| `{market_plain}` | "to win the Round of 16 match"                           | Market translation layer                                                                                                                                                                                             |
| `{category}`     | "Champions League" / "CA politics"                       | Market translation layer — the market's topic bucket. V6 only (the repeat-character count).                                                                                                                          |
| `{entry}`        | 64¢                                                      | Trade                                                                                                                                                                                                                |
| `{now}`          | 71¢                                                      | Live price at post time                                                                                                                                                                                              |
| `{gain}`         | +36¢ (64¢ → 100¢)                                        | Resolution math: payout (100¢) − `{entry}`. V8 only — computed when a previously-posted trade resolves.                                                                                                              |
| `{ago}`          | 8 min                                                    | Detection → post latency                                                                                                                                                                                             |

**Required for every post:** `{whale}` + one credibility stat (`{avg_ev}` preferred, else `{win_rate}`, backed by `{resolved}`) + `{side}` + `{entry}`. 
- *If the wallet is anonymous or the market can't be translated to a named side → **skip the trade.***

**EV gloss rule:** `{avg_ev}` never appears bare — always with a plain-English translation. Rotate glosses so no two consecutive EV posts read the same: "*profitable on average*," "*wins at the right price*," "*gets in at better prices than the market*," "*paid for disagreeing with the crowd*," "*makes money per bet, not just wins often*."

---
## Templates (rotate variant and sentence order)

**V1 — The Raw Move**
>  `{whale}` just put `{stake}` on `{side}` at `{entry}`¢. Their record: `{win_rate}`% across `{resolved}` resolved bets.
 
>  New position: `{stake}` on `{side}`, entered at `{entry}`¢. This wallet has won `{win_rate}`% of `{resolved}` bets.

> `{stake}` on `{side}` `{ago}` ago. The wallet behind it wins `{win_rate}`% of the time.

> `{whale}` just moved `{stake}` to `{side}` at `{entry}`¢. This wallet runs `{avg_ev}` AVG EV over `{resolved}` resolved bets."

**V2 — Track Record First**
> A wallet with `{resolved}` resolved bets and a `{win_rate}`% win rate just moved: `{stake}` on `{side}` at `{entry}`¢

 > `{win_rate}`% over `{resolved}` bets. That's the record behind the `{stake}` that just landed on `{side}`.
 
> This wallet averages `{avg_ev}` EV across `{resolved}` bets. New position: `{stake}` on `{side}` at `{entry}`¢.

> Anyone can win 80% betting favorites. This whale runs `{avg_ev}` EV over `{resolved}` bets as they win at the right price. Just in: `{stake}` on `{side}`.

**V3 — Entry vs Now (edge-left frame)**
> `{whale}` entered `{side}` at `{entry}`¢. It's already `{now}`¢. The move started `{ago}` ago.

> Entry: `{entry}`¢. Now: `{now}`¢. `{whale}` (`{win_rate}`% win rate) got in `{ago}` ago on `{side}`.

> `{whale}` entered `{side}` at `{entry}`¢ — it's `{now}`¢ now. Their AVG EV is `{avg_ev}`: historically they get in at better prices than the market. That gap is the edge. 
- Rule: only use F3 when `{now}` ≠ `{entry}`; if the line hasn't moved, use F1/F2.

**V4 — Conviction (stake-relative)**
> `{stake}` is `{whale}`'s biggest position this month. It's on `{side}` at `{entry}`¢.

> `{whale}` usually bets ~`{avg_stake}`. Today: `{stake}` on `{side}`.
 
> `{stake}` on `{side}` — `{whale}`'s biggest swing this month, from a wallet running `{avg_ev}` EV across `{resolved}` bets. Big size from a wallet that's profitable on average is the whole signal.
	*Requires wallet stake-history; skip template if unavailable.

**V5 — Contrarian**
> The market says `{now}`¢. `{whale}` (`{win_rate}`% over `{resolved}` bets) just took the other side at `{entry}`¢, which is `{stake}` on `{side}`.

> The crowd has this at `{now}`¢. `{whale}` took `{side}` at `{entry}`¢ with `{stake}` and their `{avg_ev}` AVG EV over `{resolved}` bets says they usually get paid for disagreeing with the crowd.
	*Only when whale's side is under ~40¢ at entry.*

**V6 — The Repeat Character**
> `{whale}` is back. Third `{category}` position this week and this time `{stake}` on `{side}` at `{entry}`¢.

 > `{whale}` again. Third `{category}` move this week: `{stake}` on `{side}` at `{entry}`¢. Still running `{avg_ev}` EV over `{resolved}` bets and still getting in at better prices than the market.
	*Only for whales already posted ≥2×. This template builds the named characters over time.*

**V7 — The Quiet Signal**
> `{stake}` on `{side}` at `{entry}`¢ from a wallet that's won `{win_rate}`% of `{resolved}` bets. Most people will never look.

> Every position on Polymarket is public. This one is `{stake}` on `{side}` by a `{win_rate}`% wallet and the price hasn't moved. Still `{now}`¢.

> `{stake}` on `{side}` at `{entry}`¢ from a wallet averaging `{avg_ev}` EV across `{resolved}` bets as they get in at better prices than the market. The market hasn't noticed yet.

> `{whale}` put `{stake}` on `{side}` `{ago}` ago. Price hasn't budged: still `{now}`¢. A `{win_rate}`% wallet moved and nobody looked up.
	*Only when `{now}` ≈ `{entry}` (within ~2¢).If the line already moved, that's V3, not V7.*

**V8 — The Receipt (resolution follow-up)**
> Update: `{whale}`'s `{stake}` on `{side}` (posted here at `{entry}`¢) just resolved YES. Entry to resolution: +`{gain}`.

> Receipt: {`whale}`'s `{stake}` on `{side}` resolved YES. Posted at `{entry}`¢, paid out at 100. This is what `{avg_ev}` AVG EV looks like — profit per bet, not luck.
	*Posted only when a previously-posted trade resolves.*

---
## Hard rules (apply to every post template)

1. **≤1 rotating contextual hashtag, usually zero** (occasionally #polymarket; vary or omit). Never a fixed trailing block on every post — that recreates the duplicate-content spam pattern. Never #Crypto — wrong category. Revisit with impression data after 30 days.
2. **No URLs in the body.** Link lives in bio + pinned post. 
3. **No sirens/🚨 every post.** Emoji sparingly, varied, or not at all. The 🚨 WHALE ALERT 🚨 format is @whale_alert's brand and a bot tell.
4. **No two posts from the same family back-to-back.** Rotate template → variant → sentence order. Near-identical consecutive posts are the explicit X policy violation.
5. **Volume:** 3–5/day, hard cap 6-8, ≥~120-180 min apart, random jitter, never 2 within 10 min.
6. **Gates before copy:** credibility floor (≥500 resolved, win rate threshold), stake floor (≥$25K to start — tune so 3–5/day qualify), freshness (≤10 min), legibility (named side exists), dedupe (one post per whale-market pair).
7. **Fail closed.** Missing slot = no post.
8. **Review queue first.** For the next 60 days every filled template goes to a human for approve/edit/kill and during this phase the approver can post manually for free (no API spend until auto-publish).
