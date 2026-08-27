
|                   |                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Product name**  | Prediction Whales (domain: N/A)    |
| **Status**        | In review                                                                                                           |
| **Owner**         | Jeremie (Product) · Vabby (Engineering)                                                             |
| **Last updated**  | 08/26/2026 — v3                                   |
| **Design source** | [Figma](https://www.figma.com/design/T4Bp4PMCSHzcDGq2aC6C2q/Prediction-Market?node-id=306-209&t=hJFLpDIs9j0QpH5J-1) |
| **Build**         | VMahajan10/MVP — [staging](https://marketpulse-sand-five.vercel.app/)                                               |
## 1. Problem alignment

### 1.1 The problem

Casual and novice bettors (sports + prediction markets) don’t have an easy way to know: 
- Which smart bets should they place
- Why those smart bets might be good 
- When profitable “whales” are entering markets and which ones
### 1.2 Evidence

**Validated:** OddsJam's prediction-market offering drew a heavy waitlist and Polysights raised ~$2M for prediction-market analytics. OddsJam reviews show users lean on +EV to judge bets; complaints cluster on price ($1,000/mo), surprise post-trial charges, and persistent odds inaccuracies — unmet trust and accessibility needs.

**Still assuming:** casual bettors who know nothing about EV want whale signals and ~5 key metrics give them enough confidence to act.

**Validation approach (updated July 2026):** launch-now. The X account + agent is the public launch and live demand test. The waitlist landing page persists as the capture point the social funnel points to and *no longer a pre-build go/no-go gate*.

### 1.3 Why now

Prediction markets went mainstream ($44.8B volume June 2026; monthly volume exceeds US legal sportsbook handle) and the audience is flooded with novices, yet every serious tool is web-only and built for professionals. Polymarket data is free and public (Gamma, CLOB, Data APIs + Polygon logs). No product combines whale entry signals with simple, mobile-first analytics.

### 1.4 Goals & success metrics

| Goal                                                    | Success metric                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Help casual bettors understand and act on whale signals | User who opens a play sees why it's good (metrics + easy-to-understand) and taps through to copy then play |
| Surface entries fast enough to act on                   | Data refresh ≤15s, leaving time to enter before lines shift                                                |
| Build a credible public audience pre-app                | X follower quality signals market need                                                                     |

## 2. Solution alignment

### 2.1 Whale eligibility (credibility gate) — UPDATED 07/2026

A wallet/trade qualifies for the feed if:

- **Stake ≥ $500** on the play
- **Average EV ≥ +3%** across the wallet's resolved history

- Avg EV = (payout − entry)/entry per resolved bet, averaged over resolved history. Win rate is a display stat as EV outranks win rate.

> [!note]
> The X agent keeps its own posting gate (≥$25K stake)
### 2.2 Riskiest assumptions

| Assumption                                                            | Test                                                                                           | What we need to see                                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Casual bettors want whale signals; ~5 metrics give confidence to copy | X account posts (live)                                                                         | Engagement quality and interest in seeing application                                                                                                                                                                                 |
| Kalshi whale identity: trades are structurally anonymous (CFTC)       | Eng spike: can positions/fills be attributed to a persistent trader identity within API terms? | A documented, repeatable identity method; sustained sub-15s polling within rate limits; no ToS blocker. <br><br>*If not possible: Kalshi plays either show a reduced card (no track record) or are excluded — decision needed (OQ-2)* |
| ≤15s refresh leaves time to act before lines move                     | Instrument detection→display latency vs line movement                                          | Sustained sub-15s without API blocks or meaningful infra cost                                                                                                                                                                         |

### 2.3 User requirements

#### Account creation
*As a new user, I want to create an account in under a minute so I can get to the feed without friction.*
**Acceptance Criteria:** email/password or one-tap Apple/Google sign-in; lands directly on the Whale Feed.
#### Whale bet feed
*As a casual/novice bettor, I want to see what reputable whales are betting right now so I can act while the signal is still live.*

**Acceptance Criteria:**
- Updates ≤15s, no manual refresh; LIVE pill in header
- **Category tabs**: All / Trending / Sports / Politics / Culture
- **Card anatomy**: 
	- Category pill + source pill (Kalshi/Polymarket) + recency 
	- Matchup/question title 
	- Whale row (avatar, pseudonym, win-rate pill) 
	- Direction pill ("Backing Miami Marlins" / "Exit by July 31") 
	- BUY/SELL tag
	- 4 stat cells: **Entry, Now, Stake, AVG EV** (color-coded, "vs. market at entry")
- Direction is always anchored to a named side — never raw YES/NO
- Whales always display as pseudonyms — never raw wallet addresses
- Only gate-passing whales appear (see 2.1)
#### Whale details
*As a casual/novice bettor, I want to see the track record behind a play so I can decide whether to trust it.*

**Acceptance Criteria:**
- One tap from feed card
- Whale strip (→ Whale Profile), play card with a short summary paragraph ("Wins 68% of plays… entered at 64¢ and it's now 71¢, so some value remains")
- Six stat cells, each with info-icon tooltip: Win Rate (with W·L record), Total Bets, Stake, AVG EV, Entry, Now
- Edge indicator line (e.g. "+10.9% · STILL SOME EDGE")
- Compliance disclaimer visible: "*This is not financial advice — we surface data from market activity. You ultimately decide what to bet on.*"
- Copy Play CTA (see below)
#### Copy-play deep link
*As a casual/novice bettor, I want to act on a signal in one tap so the line doesn't move before I get there.*

**Acceptance Criteria:** Copy Play opens the underlying platform directly on that market. User sizes their own stake on the platform (the app never auto-inputs a wager). 
#### Top metrics, explained
*As a novice, I want every metric explained in simple, plain English so I never see a number I can't interpret.*

**Acceptance Criteria:** tapping any info icon shows the plain-English tooltip (definitions in 2.4). 
#### Whale profile
*As a casual/novice bettor, I want a whale's full history so I can browse past plays and decide if they're worth following.*

**Acceptance Criteria:**
- **Header**
	- Pseudonym
	- Share action
	- Total value
	- Total gain & loss (visual bar, gain green / loss red)
- Add to Watchlist CTA
- Top stats: Win Rate (W·L) + ROI (on N plays)
- Per-category cards (Politics / Culture / Sports)
	- Win-rate pill
	- Net gain/loss
	- Invested
	- ROI
	- AVG CLV
- **Tabs**: 
	- **Positions** (open)  
	- **Trades** (history) — sortable, filterable table (Event, Market, Position, Current Value, Stake), paginated
#### Watchlist
*As a user, I want a standing view of whales I follow (performance and open positions), so I can decide who to tail and who to drop.*

**Acceptance Criteria:** 
- Star/follow from feed or profile; per-whale card with aggregate metrics (win rate, ROI ±, open plays) + up to 3 current open positions 
- Filter/sort bottom sheet 
	- Sort: Recently active / Top ROI / Highest win rate / Most open plays / Highest EV% 
	- Filter: Markets, Platform, Alerts on/off, "only whales with an open play." 
- Empty state links back to feed 
#### Alerts
*As a user, I want a running feed of my followed whales' moves so I can act while the line is live.*

**Acceptance Criteria:** newest-first rows of followed whales' entries and exits within the ~15s window; row = whale, play, direction (buy/sell + side backed), time since entry; Today/Earlier groups; All/Unread toggle; unread clears on open; taps through to Whale Details. 

#### Reputability guardrails
*As a user, I want to see only proven whales so one lucky bet never reads as a signal.*
**AC:** gate from 2.1 applied consistently — a non-qualifying wallet appears nowhere. Feed never displays a whale with negative avg EV.

### 2.4 Metric definitions

| Metric            | Why it matters                                    | Definition                                                                                                         | Shown in                             |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| **Win Rate %**    | Easiest trust signal                              | *How often this whale's bets win. 68% means roughly 7 of 10 have hit.*                                             | Feed + Details + Profile             |
| **Average EV**    | Finds profitable spots, not luck; the honest gate | *Whether a bet is priced in your favor over time. Positive means this whale finds bets worth more than they cost.* | Feed + Details (never without gloss) |
| **Total Bets**    | Track-record depth                                | *How many bets this whale has placed. 1,200 is very different from 12.*                                            | Details                              |
| **Entry vs. Now** | Is value left?                                    | *The price the whale got in at vs. right now. Close = likely still value; big move = edge may be gone.*            | Feed + Details                       |
| **Whale Stake**   | Conviction                                        | *How much the whale put on this bet. Bigger stake, stronger conviction.*                                           | Feed + Details                       |
| **ROI**           | Bottom-line profitability                         | *For every dollar this whale bet, how much they made or lost.*                                                     | Profile + Watchlist                  |
| **Avg CLV**       | Entry-timing skill                                | *How consistently this bettor got better prices than where the market ended up.* ⚠️ confirm computability          | Profile (per category)               |

### 2.5 Key flows

Feed → Details → Copy Play (deep link out) · Feed/Details → Whale Profile → Add to Watchlist · Watchlist → Alerts → Details. Bottom nav: Feed / Watchlist / Alerts.

## 3. Launch readiness (GTM)

| Milestone            | Description                                                                                     | Exit criteria                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Trust layer in build | Identity (pseudonyms), credibility gate enforcement, market translation wired into the live app | No raw addresses, no negative-EV whales, no bare YES/NO anywhere in the product |
| Design               | Build matches App-page designs: Details, Profile, category tabs, card anatomy, design tokens    | Jeremie sign-off vs Figma; debug UI                                             |
| X launch             | Account warmed up, agent in review-queue mode (per Agent Parameters doc)                        | Shadow-mode gates tuned; first public posts live                                |

**Launch checklist**

| Area      | Question                                                 | Owner     | Status        |
| --------- | -------------------------------------------------------- | --------- | ------------- |
| Marketing | X account warmup                                         | `Jeremie` | `In progress` |
| Design    | Design-system handoff (tokens/components) delivered?     | `Jeremie` | `In progress`        |
| Product   | Resolved-bets floor decided (OQ-1b)?                     | `Jeremie`   | `Open`        |
| Eng       | Trust layer (identity, gate, translation) live in build? | `Vaibhan` | `Open`        |
| Eng       | Kalshi identity spike resolved (OQ-2)?                   | `Vaibhan` | `Done`        |

## 4. Open questions

| #    | Question                                                                             | Status                      |
| ---- | ------------------------------------------------------------------------------------ | --------------------------- |
| OQ-1 | Minimum resolved-bets floor                                                          | `Open` `Jeremie`              |
| OQ-2 | Kalshi whale identity: attributable within API/ToS? If not, reduced card vs exclude? | `Resolved` `Vaibhan` — Reduced Card in feed + X agent excluded; see `docs/Kalshi Whale Attribution Audit.md` |
| OQ-3 | Refresh vs line movement: does ≤15s leave time to act?                               | `Open`                      |
| OQ-4 | Copy friction: deep link assumes funded platform account. Where does conversion die? | `Open`  <br>measure in beta |
| OQ-5 | AVG CLV: computable from Polymarket data? Definition + fallback                      | `Open` `Vaibhan`            |

## 5. Changelog

- **v2 (07/29/2026):** full MVP scope from design decisions (included Tail flow).
- **v1 (06/12–06/17/2026):** PRD + user requirements docx.
