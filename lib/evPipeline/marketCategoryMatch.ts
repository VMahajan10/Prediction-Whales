import { isSportsMarketProbe } from "@/lib/evPipeline/sportsSlugParse";
import { inferMarketCategory } from "@/lib/marketCategory";
import type { NormalizedMarketContract } from "@/lib/evPipeline/types";

/** Strict buckets for cross-platform pair eligibility. */
export type MappingCategory =
  | "sports"
  | "crypto"
  | "macro"
  | "politics"
  | "culture"
  | "weather"
  | "other";

const KALSHI_SERIES_RULES: Array<{ pattern: RegExp; category: MappingCategory }> =
  [
    {
      pattern:
        /^KX(NFL|NBA|MLB|NHL|MLS|WNBA|NCAA|WC|ITF|WTA|ATP|UFC|F1|SOCCER|CLUBWC|WCGAME|WCTOTAL|WCSPREAD|WCHIT|MENTION)/i,
      category: "sports",
    },
    { pattern: /^KX(BTC|BTCD|ETH|SOL|DOGE|XRP|CRYPTO|SHIB)/i, category: "crypto" },
    {
      pattern: /^KX(FED|FOMC|CPI|GDP|UNRATE|RECESSION|INFL|RATE|JOBS|DEBT)/i,
      category: "macro",
    },
    {
      pattern:
        /^KX(ELON|GRAMMY|OSCARS|TIKTOK|TWITTER|SPOTIFY|MENTION|NEWPOPE|WARMING)/i,
      category: "culture",
    },
    { pattern: /^KX(HURR|TEMP|WEATHER|RAIN|SNOW|CLIMATE)/i, category: "weather" },
    {
      pattern:
        /^KX(PRES|HOUSE|SENATE|ELECTION|GOVPOLL|IMPEACH|CHINA|TAIWAN|UKRAINE|IRAN|ISRAEL|WAR|NATO|GOV)/i,
      category: "politics",
    },
  ];

function seriesTickerFromKalshi(ticker: string): string {
  return ticker.split("-")[0] ?? ticker;
}

function classifyCorpus(corpus: string): MappingCategory {
  const t = corpus.toLowerCase();

  if (isSportsMarketProbe(null, corpus)) return "sports";

  if (/\b(btc|bitcoin|ethereum|eth|solana|crypto|doge|xrp)\b/.test(t)) {
    return "crypto";
  }
  if (
    /\b(fed\b|fomc|cpi\b|gdp\b|inflation|unemployment|interest rate|rate cut|rate hike|jobs report|recession)\b/.test(
      t
    )
  ) {
    return "macro";
  }
  if (
    /\b(china|taiwan|ukraine|russia|iran|israel|war\b|invade|election|congress|senate|president|trump|biden|geopolitic|nato)\b/.test(
      t
    )
  ) {
    return "politics";
  }
  if (/\b(elon|musk|tweet|twitter|tiktok|oscar|grammy|celebrity|culture)\b/.test(t)) {
    return "culture";
  }
  if (/\b(hurricane|temperature|weather|rain|snow|celsius|fahrenheit)\b/.test(t)) {
    return "weather";
  }

  const inferred = inferMarketCategory(corpus);
  if (inferred === "SPORTS") return "sports";
  if (inferred === "CRYPTO") return "crypto";
  if (inferred === "CULTURE") return "culture";
  if (inferred === "POLITICS") return "politics";
  return "other";
}

export function classifyPmContract(
  contract: NormalizedMarketContract
): MappingCategory {
  const corpus = [
    contract.slug,
    contract.eventSlug,
    contract.title,
    contract.description,
  ]
    .filter(Boolean)
    .join(" ");

  return classifyCorpus(corpus);
}

export function classifyKalshiContract(
  contract: NormalizedMarketContract
): MappingCategory {
  const series = seriesTickerFromKalshi(contract.tokenOrTicker);
  for (const rule of KALSHI_SERIES_RULES) {
    if (rule.pattern.test(series)) return rule.category;
  }

  const corpus = [contract.title, contract.description, series].join(" ");
  return classifyCorpus(corpus);
}

/** Categories must match exactly — no cross-domain pairing. */
export function mappingCategoriesCompatible(
  pmCategory: MappingCategory,
  kalshiCategory: MappingCategory
): boolean {
  return pmCategory === kalshiCategory;
}

export function contractsMappingCompatible(
  pm: NormalizedMarketContract,
  kalshi: NormalizedMarketContract
): boolean {
  return mappingCategoriesCompatible(
    classifyPmContract(pm),
    classifyKalshiContract(kalshi)
  );
}
