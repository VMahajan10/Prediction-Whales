import { formatWhaleSignedPercent, formatWhaleWinRatePercent } from "@/lib/whaleIdentityResolver";

export const WHALE_DETAILS_DISCLAIMER =
  "This is not financial advice as we surface data from market activity. You ultimately decide what to bet on.";

export const WHALE_METRIC_TOOLTIPS = {
  winRate:
    "How often this whale's bets win. 68% means roughly 7 of 10 have hit.",
  totalBets:
    "How many bets this whale has placed. 1,200 is very different from 12.",
  stake:
    "How much the whale put on this bet. Bigger stake, stronger conviction.",
  avgEv:
    "Whether a bet is priced in your favor over time. Positive means this whale finds bets worth more than they cost.",
  entry:
    "The price the whale got in at when this play was placed.",
  now: "The current market price. Compare to entry to see if value remains.",
} as const;

export type WhaleMetricKey = keyof typeof WHALE_METRIC_TOOLTIPS;

export interface EdgeIndicator {
  percentLabel: string;
  statusLabel: string;
  positive: boolean | null;
}

export function formatStakeCompact(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) {
    const rounded = Math.round(usd / 1_000);
    return `$${rounded}K`;
  }
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

export function formatPriceCents(price: number): string {
  if (!Number.isFinite(price)) return "—";
  return `${Math.round(price * 100)}¢`;
}

export function estimateWinsLosses(
  winRate: number | null | undefined,
  totalBets: number | null | undefined
): { wins: number | null; losses: number | null } {
  if (
    winRate == null ||
    totalBets == null ||
    !Number.isFinite(winRate) ||
    !Number.isFinite(totalBets) ||
    totalBets <= 0
  ) {
    return { wins: null, losses: null };
  }

  const rate = winRate <= 1 ? winRate : winRate / 100;
  const wins = Math.round(rate * totalBets);
  return { wins, losses: Math.max(0, totalBets - wins) };
}

export function resolveEdgeIndicator(
  entryPrice: number,
  currentPrice: number,
  side: "BUY" | "SELL"
): EdgeIndicator {
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(currentPrice) ||
    entryPrice <= 0
  ) {
    return {
      percentLabel: "—",
      statusLabel: "PRICE UNAVAILABLE",
      positive: null,
    };
  }

  const rawDeltaPct = ((currentPrice - entryPrice) / entryPrice) * 100;
  const favorable =
    side === "BUY" ? rawDeltaPct >= 0 : rawDeltaPct <= 0;
  const absDelta = Math.abs(rawDeltaPct);
  const sign = rawDeltaPct >= 0 ? "+" : "";
  const percentLabel = `${sign}${absDelta.toFixed(1)}%`;

  if (absDelta < 1.5) {
    return {
      percentLabel: "0.0%",
      statusLabel: "STILL AT ENTRY",
      positive: null,
    };
  }

  if (favorable) {
    if (absDelta < 15) {
      return {
        percentLabel,
        statusLabel: "STILL SOME EDGE",
        positive: true,
      };
    }
    return {
      percentLabel,
      statusLabel: "MOST EDGE GONE",
      positive: null,
    };
  }

  if (absDelta < 8) {
    return {
      percentLabel,
      statusLabel: "LINE SHIFTED",
      positive: false,
    };
  }

  return {
    percentLabel,
    statusLabel: "EDGE FADING",
    positive: false,
  };
}

export function buildWhaleSummaryParagraph(input: {
  winRate: number | null;
  avgEv: number | null;
  totalBets: number | null;
  entryPrice: number;
  currentPrice: number;
  stakeUsd: number;
}): string {
  const parts: string[] = [];
  const winRatePct =
    input.winRate == null ? null : formatWhaleWinRatePercent(input.winRate);
  const avgEvLabel =
    input.avgEv == null ? null : formatWhaleSignedPercent(input.avgEv);

  if (winRatePct && winRatePct !== "—") {
    let opener = `Wins ${winRatePct} of plays`;
    if (avgEvLabel && avgEvLabel !== "—" && !avgEvLabel.startsWith("-")) {
      opener += " and consistently finds +EV spots";
    }
    if (input.totalBets != null && input.totalBets > 0) {
      opener += ` with ${input.totalBets.toLocaleString("en-US")} total bets`;
    }
    parts.push(`${opener}.`);
  } else if (input.totalBets != null && input.totalBets > 0) {
    parts.push(
      `This whale has ${input.totalBets.toLocaleString("en-US")} resolved bets on record.`
    );
  }

  const entry = formatPriceCents(input.entryPrice);
  const now = formatPriceCents(input.currentPrice);
  const entryCents = Math.round(input.entryPrice * 100);
  const nowCents = Math.round(input.currentPrice * 100);

  if (Math.abs(nowCents - entryCents) <= 1) {
    parts.push(`Entered play at ${entry} and odds are still near entry.`);
  } else if (nowCents > entryCents) {
    parts.push(
      `Entered play at ${entry} and it's now ${now}, so some value remains.`
    );
  } else {
    parts.push(
      `Entered play at ${entry} and it's now ${now} — the line has moved since entry.`
    );
  }

  parts.push(
    `The ${formatStakeCompact(input.stakeUsd)} stake signals strong conviction.`
  );

  return parts.join(" ");
}
