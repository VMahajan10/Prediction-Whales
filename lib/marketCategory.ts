export type MarketCategory =
  | "SPORTS"
  | "POLITICS"
  | "CULTURE"
  | "CRYPTO"
  | "MARKET";

export type CategoryTone = "sports" | "politics" | "culture" | "default";

const ESPORTS_PROBE =
  /lol|lec|lcs|lck|lpl|cs2|csgo|valorant|dota|dota2|esports|esport|vct|msi|worlds|blast|iem|esl|major|map\s*\d/i;

export function inferMarketCategory(title: string): MarketCategory {
  const t = title.toLowerCase();
  if (
    /mlb|marlins|pirates|vs\.|nfl|nba|nhl|mls|fifa|world cup|goals|spread|soccer|o\/u|wta|atp|tennis|yankees|dodgers|lakers|celtics/.test(
      t
    ) ||
    ESPORTS_PROBE.test(t)
  ) {
    return "SPORTS";
  }
  if (
    /congress|trump|election|senate|president|house|federal|fed |governor|primary|democrat|republican/.test(
      t
    )
  ) {
    return "POLITICS";
  }
  if (/oscar|grammy|movie|album|celebrity|tiktok|twitter|culture/.test(t)) {
    return "CULTURE";
  }
  if (/btc|eth|crypto|bitcoin|solana|token/.test(t)) {
    return "CRYPTO";
  }
  return "MARKET";
}

export function inferCategoryBadge(title: string): {
  label: string;
  tone: CategoryTone;
} {
  const t = title.toLowerCase();
  if (/wta|tennis/.test(t)) return { label: "WTA", tone: "sports" };
  if (/atp/.test(t)) return { label: "ATP", tone: "sports" };
  if (/mlb|marlins|pirates|yankees|dodgers/.test(t))
    return { label: "MLB", tone: "sports" };
  if (/nba|lakers|celtics/.test(t)) return { label: "NBA", tone: "sports" };
  if (/nfl/.test(t)) return { label: "NFL", tone: "sports" };
  if (/fifa|world cup|soccer/.test(t))
    return { label: "SOCCER", tone: "sports" };
  if (/lol|lec|lcs|lck|lpl/.test(t))
    return { label: "ESPORTS", tone: "sports" };
  if (/cs2|csgo|valorant|dota/.test(t))
    return { label: "ESPORTS", tone: "sports" };
  if (/congress|house of representatives/.test(t))
    return { label: "CONGRESS", tone: "politics" };
  if (/federal|fed chair|fed rate/.test(t))
    return { label: "FEDERAL", tone: "politics" };
  if (/trump|biden|election|president|senate/.test(t))
    return { label: "POLITICS", tone: "politics" };
  if (/oscar|grammy|celebrity/.test(t))
    return { label: "CULTURE", tone: "culture" };

  const category = inferMarketCategory(title);
  if (category === "SPORTS") return { label: "SPORTS", tone: "sports" };
  if (category === "POLITICS") return { label: "POLITICS", tone: "politics" };
  if (category === "CULTURE") return { label: "CULTURE", tone: "culture" };
  return { label: "MARKET", tone: "default" };
}

export function categoryBadgeClass(tone: CategoryTone): string {
  switch (tone) {
    case "sports":
      return "bg-pulse-accent/20 text-pulse-accent";
    case "politics":
      return "bg-blue-500/20 text-blue-400";
    case "culture":
      return "bg-purple-500/20 text-purple-300";
    default:
      return "bg-pulse-surface text-pulse-muted";
  }
}
