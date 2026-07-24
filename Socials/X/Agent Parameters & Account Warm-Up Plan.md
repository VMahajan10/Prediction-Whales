
"*Launch now, skip the waitlist-as-strategy*" 
Agree, strongly. The market window argument is even stronger than he knows (see timing section).

"*Have an agent post every time a whale account makes a trade*" 
The accounts that won this content category (*Unusual Whales 4.7M, PelosiTracker 1M+, PolymarketIntel 829k*) all won on curated, human-voiced, narrative posting with automation underneath. Posting every trade also literally violates X's automation policy (near-identical repeated posts) and walks into the 2025–26 bot purge waves.

> [!note] 
> Build the agent as a *detection* engine. The bot finds and drafts with edits of a human, personified voice and publish 3–8 high-signal posts a day.

---
## Common X Bot Accounts

| Account                                                | Model                                                        | Result                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [@PolymarketIntel](https://x.com/PolymarketIntel?s=20) | Human-framed news powered by Polymarket data                 | 23.7k posts → 829k (since Feb 2022)                                            |
| [@PolyWhaleAlerts](https://x.com/PolyWhaleAlerts?s=20) | Pure bot, posts every whale trade                            | 9K+ posts → 598 followers (since Dec 2025)                                     |
| [@kalshiwhales](https://x.com/kalshiwhales?s=20)       | Pure bot (best performer of the bots)                        | 3,200+ posts → ~2,400 followers (since Jun 2025)                               |
| [@0xinsiderdotcom](https://x.com/0xinsiderdotcom?s=20) | Pure bots / tool accounts                                    | ~1,114+ posts → ~180 followers (since Feb 2026)                                |
| [@Domahhhh ](https://x.com/Domahhhh?s=20)(Domer)       | Human whale, occasional viral whale-spotting threads         | ~3,177 posts → ~41k followers (since Jan 2018); massively influential per post |
| [@unusual_whales](https://x.com/unusual_whales?s=20)   | Automation underneath + human/meme voice + mission narrative | 159.7K posts → ~4.7M (since Nov 2019)                                          |
| [@whale_alert](https://x.com/whale_alert?s=20)         | Crypto whale-transaction alert bot                           | ~99.8k posts → ~2.8M followers (since Sep 2018)                                |

Existing core formula: 
- A persona (the "Mr. Whale" meme voice)
- A mission ("*expose congressional trading / fight for fair markets*") 
- A news-desk cadence that reframed raw data as "BREAKING stories".

> [!info] PW X account formula: 
> - Make specific whales recurring named personas with visible track records 
> - Anchor the account to a moral/transparency hook 
> - Let events drive the headline posts (*a whale exiting days before news breaks, a contrarian entry*)
> - Treat the account as a behavioral demo of the app — every post rehearses the product's core loop

Whale Alert's posts are market-moving (aggressive thresholds → near-100% signal density), and wallet labels supply an implied narrative - "who is this whale, what's their record, is there edge left" context, which is PW's product.

### FYI

- X's automation rules prohibit "duplicative or substantially similar posts" and repeated link-only posts 
- API pricing changed in Feb 2026 to pay-per-use: $0.015 per plain post, $0.20 per post containing a URL (verified on docs.x.com today). Cost is ~$3–5/mo
- Link posts are heavily suppressed for reach anyway (Buffer's 18.8M-post study: near-zero median engagement on non-Premium link posts). So: **no URLs in post bodies.** Waitlist/app link lives in bio and pinned post; link goes in a reply when someone asks.

### Market Signals

- Prediction markets did $44.8B combined volume in June 2026 (World Cup peak); monthly volume now *exceeds US legal sportsbook handle*. Kalshi: $22B valuation (Mar 2026), reportedly raising at $40B. Polymarket: ICE invested up to $2B; US app now open (iOS).
- The dashboard niche went from ~2 tools in 2024 to 8–10 shipping products by mid-2026. Cluster of web-based analytics sites for tracking prediction-market whales 
	- [Polymarket Analytics](https://polymarketanalytics.com/)
	- [Hashdive](https://hashdive.com/) 
	- [Polywhaler](https://polywhaler.com/) 
	- [Polysights](https://www.polysights.xyz/) 
	- [PredictFolio](https://predictfolio.com/) 
	- [OrcaLayer](https://orcalayer.com/)

- Nobody has a *mobile-first, casual-audience, plain-English* — positioning still holds because everyone else is building pro-facing web dashboards. 
---
## Parameter specs

The agent's job: **watch every whale trade, post almost none of them.** 

**A0. Prerequisites (build before any public posting):**

- **Wallet registry** 
	- Per-whale track record (resolved bets, win rate, AVG EV, stake history) + a pseudonym naming scheme so recurring whales become personas. Never raw addresses; "Address: Anonymous" can't pass the credibility gate.
	- AVG EV definition: per resolved bet, (payout − entry price) / entry price, averaged across the wallet's resolved history. Posts shall contains **whale avg EV + entry-vs-now** framing (e.g. "*entered at 10¢ & AVG EV +12% → this whale is profitable*").
- **Market translation formula** 
	- `{stake} on {side} {market_plain}` → EXAMPLE: "$1.8K" + "Zhang" + "to win the Round of 16 match"
	- INPUT: Market (ticker/question + outcome structure) and the whale's position (which outcome token they bought, Yes or No, or a specific outcome in multi-outcome markets)
	- OUTPUT: Named entity/side (athlete/political/movie/event name) + whale's position and market context ("round of 16 match", "to win the EPL")
- **Data source rule**
	- Public output runs on Polymarket data only for now — Kalshi trades are structurally anonymous (CFTC), so they can feed internal detection but can never produce a post that passes the credibility gate.

**A. Eligibility (a trade must pass ALL to enter the queue):**

| Gate              | Parameter                                                                                                                                             | Rationale                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Whale credibility | ≥500 resolved bets and AVG EV ≥+3% (tune); win rate ≥55% as secondary/display stat — *EV outranks win rate: 60% WR at +10% EV beats 89% WR at −5% EV* | Post as proof the vetting works;  EV is the honest profitability signal                                                         |
| Stake floor       | ≥$25K notional, tune per category so ~3-5 trades/day                                                                                                  | Threshold density is what made Whale Alert work                                                                                 |
| Freshness         | Entry detected ≤10 min ago; skip if current price has already moved >X¢ from entry                                                                    | Fulfills entry-vs-current metric and markets PW's one of MVP features                                                           |
| Market legibility | Market has a human-readable framing <br>- Sports team<br>- Athlete name<br>- Political candidate/name <br>- Event/movie name<br>- Actor/Actress name  | Never post raw "YES on will-X-happen" — anchor naming direction as reflected in the MVP (dashboard card component as reference) |
| Dedupe / cooldown | One post per whale-market pair; ≥45 min between any two posts; max 1 post per market per day                                                          | X duplicate-content policy + burst posting is a top flag                                                                        |

**B. Volume and timing:**

- 3–5 published posts/day, hard cap 6-8
- Randomized jitter of ~120-180 mins on every scheduled post; never post on exact minute boundaries; vary daily count ±2. (Regularity is the detection signal — accounts posting at :00 each hour got flagged in the June 2026 purge.)
- No burst posting: never 2 posts within 10 minutes.

**C. Content rules:**

- Rotate ≥8 copy templates with variable orderings and phrasings, so no two posts are near-identical. Numbers alone don't count as variation.
	- Template families: 
		- *Raw move*
		- *Track-record frame*
		- *Entry-vs-now frame*
		- *Conviction frame*
		- *"Line hasn't caught up" frame*
	- Full pack drafted with variable schema + hard rules: see **X Agent Copy Templates v1.md**
- No URLs in the post body ($0.20/post + reach suppression). Link in bio, pinned post, and replies on request.
- Generated card from MVP per post where possible (PW's dark/orange design system — Vaib to use tokens for brand consistency).
- ≤2 rotating contextual hashtag (occasionally #polymarket). Never a fixed trailing block — #polymarket #whale #EV on every post recreates the duplicate-content spam pattern and X's policy explicitly flags excessive/unrelated hashtags. 
- Every post names the whale (pseudonymous handle) + one credibility stat (AVG EV preferred — always paired with a plain-English wording like "profitable on average" — or win rate) + one urgency stat (entry vs now). 
	- Named recurring whales become characters/personas based on their betting habits/patterns 
	**EXAMPLES**: 
	- "The French whale" - a french trader who made ~$50M+
	- "Mr. 100" - anonymous wallet that kept buying 100 BTC
	- "Domer" - full-time political bettor

**D. Compliance and safety:**

- Register via the official X API on a Developer account; apply the Automated-account label and link it to PW's account. Disclose "automated alerts + human analysis" in bio. Verify the current test pipeline also posts via the official API 
- **Shadow mode before public mode:** run the full gate stack silently for ≥1 week, logging what would have posted. Tunes the 3–5/day target and answers the whale-supply question with real data before a public post.
- **Human-in-the-loop for the first 60 days:** agent drafts into a review queue (Slack/Telegram), a human approves/edits/kills with one tap. This is both a safety valve and how you learn which templates hit before automating them. Graduate to auto-publish per template once they have ~50 clean approvals.
- Kill switch + anomaly alarm (if the agent queues >15/day, something's mis-tuned; halt).
- **Budget**: posts/day this is ~$2.25/month in API credits

**E. Plan for it explicitly:**
One human-authored piece per week: 
- *Receipts thread (X1 template)*
- *"This whale just did something weird" story*
- *Build-in-public note*

### Account warm-up 

**Week 0:**
- Complete profile before anything else: avatar, banner (design-system dark/orange), bio with disclosure + positioning line, pinned post. 

**Weeks 1–2 (manual only, consume-first):**
- **Days 1–3:** log in daily, browse, follow 5–10 relevant accounts/day from the Channel Target; 10–15 likes/day, no posts.
- **Days 4–14**: 1 manual post/day (screenshots of real whale moves — X2 "single screenshot" template), 1–3 manual replies/day in the reply sections of @Polymarket / @Kalshi / @unusual_whales posts 
- All activity from a consistent residential IP/normal device. 

**Weeks 3–4 (introduce the agent at ~30%):**
- Agent goes live in review-queue mode, 3-5 approved posts/day layered on continuing manual activity.
- Founder accounts start QT-ing/replying to the brand account's best posts (organic, not scheduled — coordinated automation across accounts is a policy violation).

**Weeks 5–6 (ramp to cruise):**
- 5 posts/day, first human receipts thread published, first "whale character" recurring storyline.
- Keep engagement (likes/follows/replies) 100% manual; automate content only

**Metrics**: 
- Bookmarks over likes
- "Is there a tool?" replies
- Profile visits → bio-link taps 
- Follows from bettor profiles. If posts get zero impressions for days (shadow-limit symptom), stop, slow down, let the account breathe a week.

**Other platforms:** same logic compressed — TikTok/IG accounts should start posting the T1/T2 faceless scripts in week 1 (no automation risk there; the constraint is content supply). The X agent is unique in needing platform-trust warm-up.

---
## Sources (key claims)

- X automation rules / labels / platform-manipulation policy: [help.x.com/automation](https://help.x.com/en/rules-and-policies/x-automation), [help.x.com/automated-account-labels](https://help.x.com/en/using-x/automated-account-labels), [help.x.com/platform-manipulation](https://help.x.com/en/rules-and-policies/platform-manipulation), [help.x.com/x-limits](https://help.x.com/en/rules-and-policies/x-limits)
- X API pay-per-use pricing (verified 7/22/26): [docs.x.com pricing](https://docs.x.com/x-api/getting-started/pricing); Feb 2026 transition: [roboin.io](https://roboin.io/article/en/2026/02/08/x-transitions-api-to-pay-per-use-model-ending-free-plan/)
- Bot purges / enforcement: [socialmediatoday.com](https://www.socialmediatoday.com/news/x-formerly-twitter-conducting-bot-purge-removal/817160/), [wionews.com](https://www.wionews.com/technology/x-removed-over-1-7-million-bots-dm-spam-next-says-product-head-nikita-bier-1760344720045)
- Premium reach / link suppression: [Buffer study](https://buffer.com/resources/x-premium-review/)
- Warm-up practice (folk wisdom, flagged as such): [socialnexis.com](https://socialnexis.com/guides/twitter-automation-safe-2026), [opentweet.io](https://opentweet.io/blog/twitter-automation-rules-2026)
- Unusual Whales history & Unusual Predictions: [Finance Magnates](https://www.financemagnates.com/cryptocurrency/unusual-whales-extends-insider-radar-to-prediction-markets-with-unusual-predictions/), [Forbes](https://www.forbes.com/sites/investor-hub/article/what-is-unusual-whales/), [CJR](https://www.cjr.org/tow_center/polymarket-affiliates-are-spreading-misinformation-on-x.php)
- Whale Alert: [The Block interview](https://www.theblock.co/amp/post/68664/a-conversation-with-whale-alert-one-of-crypto-twitters-most-mysterious-watchdogs), [BTCBOX interview](https://blog.btcbox.jp/en/archives/7887)
- PelosiTracker → Autopilot: [Salon](https://www.salon.com/2025/03/17/pelosi-tracker-shows-us-how-to-trade-stocks-like-politicians/), [InvestmentNews](https://www.investmentnews.com/fintech/autopilot-surges-to-750m-aum-touts-ria-growth-as-users-copy-pelosi-buffett-trades/260729)
- Market volumes & valuations: [The Block June volumes](https://www.theblock.co/post/406983/kalshi-polymarket-volume-45-billion), [Pew](https://www.pewresearch.org/short-reads/2026/05/27/trading-volume-on-prediction-markets-has-soared-in-recent-months/), [Bloomberg Kalshi $22B](https://www.bloomberg.com/news/articles/2026-03-19/kalshi-gets-1-billion-in-new-funding-at-22-billion-valuation), [CoinDesk Kalshi $40B target](https://www.coindesk.com/business/2026/06/24/kalshi-targets-a-massive-usd40-billion-valuation-widening-lead-over-rival-polymarket)
- Whale-tracker competitive landscape: [OrcaLayer comparison](https://orcalayer.com/blog/polymarket-whale-trackers-compared), [Arkham](https://info.arkm.com/research/how-to-track-polymarket-whales), [0xInsider build notes (Kalshi anonymity)](https://www.trevorlasn.com/blog/0xinsider-prediction-market-whale-tracking)
- Bot-account follower counts: twtdata.com pulls 7/22/26 (approximate)
