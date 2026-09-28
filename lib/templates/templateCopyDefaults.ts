import type { TemplateFamilyCopy } from "@/lib/templates/templateCopyData";

/**
 * Bundled fallback pool — used when DB template rows are missing or invalid.
 * Runtime edits live in `x_agent_template_variants` (see templateCopyStore.ts).
 */
export const TEMPLATE_FAMILY_COPY_DEFAULTS: TemplateFamilyCopy[] = [
  {
    family: "V1",
    variants: [
      {
        id: "a",
        credibility: "win_rate",
        required: ["whale", "stake", "side", "entry", "winRate", "resolved"],
        sentences: [
          "{whale} just put {stake} on {side} at {entry}. Their record: {winRate} across {resolved} resolved bets.",
        ],
      },
      {
        id: "b",
        credibility: "win_rate",
        required: [
          "whale",
          "stake",
          "side",
          "entry",
          "winRate",
          "resolved",
        ],
        sentences: [
          "{whale} opened a new position: {stake} on {side} at {entry}. This wallet has won {winRate} of {resolved} bets.",
        ],
      },
      {
        id: "c",
        credibility: "win_rate",
        required: [
          "whale",
          "stake",
          "side",
          "entry",
          "ago",
          "winRate",
          "resolved",
        ],
        sentences: [
          "{whale}: {stake} on {side} at {entry}, {ago} ago. Track record: {winRate} across {resolved} resolved bets.",
        ],
      },
      {
        id: "d",
        credibility: "avg_ev",
        required: [
          "whale",
          "stake",
          "side",
          "entry",
          "avgEv",
          "evGloss",
          "resolved",
        ],
        sentences: [
          "{whale} just moved {stake} to {side} at {entry}. This wallet runs {avgEv} AVG EV over {resolved} resolved bets — {evGloss}.",
        ],
      },
    ],
  },
  {
    family: "V2",
    variants: [
      {
        id: "a",
        credibility: "win_rate",
        required: ["whale", "resolved", "winRate", "stake", "side", "entry"],
        sentences: [
          "{whale} — {resolved} resolved bets, {winRate} win rate — just moved {stake} on {side} at {entry}.",
        ],
      },
      {
        id: "b",
        credibility: "win_rate",
        required: ["whale", "winRate", "resolved", "stake", "side", "entry"],
        sentences: [
          "{whale}: {winRate} over {resolved} bets. That's the record behind {stake} on {side} at {entry}.",
        ],
      },
      {
        id: "c",
        credibility: "avg_ev",
        required: [
          "whale",
          "avgEv",
          "evGloss",
          "resolved",
          "stake",
          "side",
          "entry",
        ],
        sentences: [
          "{whale} averages {avgEv} EV across {resolved} bets — {evGloss}. New position: {stake} on {side} at {entry}.",
        ],
      },
      {
        id: "d",
        credibility: "avg_ev",
        required: [
          "whale",
          "avgEv",
          "resolved",
          "stake",
          "side",
          "entry",
        ],
        sentences: [
          "{whale} runs {avgEv} EV over {resolved} bets by consistently getting in at the right price. Just in: {stake} on {side} at {entry}.",
        ],
      },
    ],
  },
  {
    family: "V3",
    variants: [
      {
        id: "a",
        credibility: "win_rate",
        required: ["whale", "side", "entry", "now", "ago", "winRate", "resolved"],
        sentences: [
          "{whale} entered {side} at {entry}. It's already {now}.",
          "{winRate} over {resolved} bets; the move started {ago} ago.",
        ],
      },
      {
        id: "b",
        credibility: "win_rate",
        required: ["entry", "now", "whale", "winRate", "resolved", "ago", "side"],
        sentences: [
          "Entry: {entry}. Now: {now}.",
          "{whale} ({winRate} over {resolved} bets) got in {ago} ago on {side}.",
        ],
      },
      {
        id: "c",
        credibility: "avg_ev",
        required: ["whale", "side", "entry", "now", "avgEv", "resolved"],
        sentences: [
          "{whale} entered {side} at {entry} — it's {now} now.",
          "Their AVG EV is {avgEv}: historically they get in at better prices than the market.",
          "That gap is the edge.",
        ],
      },
    ],
  },
  {
    family: "V4",
    variants: [
      {
        id: "a",
        credibility: "win_rate",
        required: [
          "stake",
          "whale",
          "side",
          "entry",
          "avgStake",
          "winRate",
          "resolved",
        ],
        sentences: [
          "{whale}: {stake} on {side} at {entry}, versus their typical {avgStake} stake ({winRate} across {resolved} resolved bets).",
        ],
      },
      {
        id: "b",
        credibility: "win_rate",
        required: [
          "whale",
          "avgStake",
          "stake",
          "side",
          "entry",
          "winRate",
          "resolved",
        ],
        sentences: [
          "{whale} usually bets {avgStake}. Today: {stake} on {side} at {entry} ({winRate} over {resolved} bets).",
        ],
      },
      {
        id: "c",
        credibility: "avg_ev",
        required: [
          "stake",
          "side",
          "whale",
          "avgEv",
          "resolved",
          "entry",
          "avgStake",
        ],
        sentences: [
          "{whale}: {stake} on {side} at {entry} — versus their typical {avgStake} stake, wallet running {avgEv} AVG EV across {resolved} bets.",
          "Big size from a wallet that's profitable on average is the whole signal.",
        ],
      },
    ],
  },
  {
    family: "V5",
    variants: [
      {
        id: "a",
        credibility: "win_rate",
        required: [
          "now",
          "whale",
          "winRate",
          "resolved",
          "entry",
          "stake",
          "side",
        ],
        sentences: [
          "The market says {now}. {whale} ({winRate} over {resolved} bets) backed {side} at {entry} — {stake} on the line.",
        ],
      },
      {
        id: "b",
        credibility: "avg_ev",
        required: [
          "now",
          "whale",
          "side",
          "entry",
          "stake",
          "avgEv",
          "resolved",
        ],
        sentences: [
          "The crowd has this at {now}. {whale} backed {side} at {entry} with {stake}. Their {avgEv} AVG EV over {resolved} bets suggests they've historically found better entry prices.",
        ],
      },
    ],
  },
  {
    family: "V6",
    variants: [
      {
        id: "a",
        credibility: "win_rate",
        required: [
          "whale",
          "stake",
          "side",
          "entry",
          "repeatOrdinal",
          "winRate",
          "resolved",
        ],
        sentences: [
          "{whale} is back for a third tracked move: {stake} on {side} at {entry} ({winRate} across {resolved} resolved bets).",
        ],
      },
      {
        id: "b",
        credibility: "avg_ev",
        required: [
          "whale",
          "stake",
          "side",
          "entry",
          "avgEv",
          "resolved",
          "repeatOrdinal",
        ],
        sentences: [
          "{repeatOrdinal} time we've flagged {whale}: {stake} on {side} at {entry}.",
          "Still running {avgEv} EV over {resolved} bets and still getting in at better prices than the market.",
        ],
      },
    ],
  },
  {
    family: "V7",
    variants: [
      {
        id: "a",
        credibility: "win_rate",
        required: ["whale", "stake", "side", "entry", "winRate", "resolved", "now"],
        sentences: [
          "{whale}: {stake} on {side} at {entry} — {winRate} win rate across {resolved} bets. Most people will never look.",
        ],
      },
      {
        id: "b",
        credibility: "win_rate",
        required: ["whale", "stake", "side", "winRate", "resolved", "now", "entry"],
        sentences: [
          "Every position on Polymarket is public. {whale}: {stake} on {side} at {entry} ({winRate} over {resolved} bets). Still {now}.",
        ],
      },
      {
        id: "c",
        credibility: "avg_ev",
        required: [
          "whale",
          "stake",
          "side",
          "entry",
          "avgEv",
          "resolved",
          "now",
        ],
        sentences: [
          "{whale}: {stake} on {side} at {entry} — wallet averaging {avgEv} EV across {resolved} bets as they get in at better prices than the market. The market hasn't noticed yet.",
        ],
      },
      {
        id: "d",
        credibility: "win_rate",
        required: ["whale", "stake", "side", "entry", "ago", "now", "winRate", "resolved"],
        sentences: [
          "{whale} put {stake} on {side} at {entry}, {ago} ago. Price hasn't budged: still {now}. {winRate} win rate across {resolved} resolved bets and nobody looked up.",
        ],
      },
    ],
  },
  {
    family: "V8",
    variants: [
      {
        id: "a",
        credibility: "win_rate",
        required: ["whale", "stake", "side", "entry", "gain", "winRate", "resolved"],
        sentences: [
          "Update: {whale}'s {stake} on {side} at {entry} (posted here) just resolved YES. Entry to resolution: {gain}. Track record: {winRate} across {resolved} bets.",
        ],
      },
      {
        id: "b",
        credibility: "avg_ev",
        required: ["whale", "stake", "side", "entry", "gain", "avgEv", "resolved"],
        sentences: [
          "Receipt: {whale}'s {stake} on {side} at {entry} resolved YES. Paid out at 100¢. This is what {avgEv} AVG EV looks like — profit per bet, not luck.",
        ],
      },
    ],
  },
];
