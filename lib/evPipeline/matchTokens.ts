import type { NormalizedMarketContract } from "@/lib/evPipeline/types";
import { contractsMappingCompatible } from "@/lib/evPipeline/marketCategoryMatch";
import { contractsSportsMarketTypeCompatible } from "@/lib/evPipeline/sportsStructureMatch";
import { countryNameToPm } from "@/lib/sportsTeamMatch";

/** Added to raw cosine similarity when token overlap is strong. */
export const TOKEN_SIMILARITY_BOOST = 0.25;

const CRYPTO_ASSET_KEYWORDS = new Set(["btc", "eth"]);
const SPORTS_LEAGUE_KEYWORDS = new Set(["nfl", "nba", "mlb", "nhl", "world_cup"]);
const MACRO_ENTITY_KEYWORDS = new Set([
  "fed",
  "cpi",
  "gdp",
  "inflation",
  "unemployment",
  "rate_cut",
  "rate_hike",
  "recession",
  "tariff",
  "interest_rate",
]);

/** Floor score when explicit token heuristic matches. */
export const TOKEN_HEURISTIC_OVERRIDE_SCORE = 0.85;

export type MatchScoreMethod =
  | "vector"
  | "token_boost"
  | "token_heuristic"
  | "sports_structure"
  | "TEST_FALLBACK_PAIR";

export interface ContractTokens {
  numbers: string[];
  keywords: string[];
  /** YYYY-MM expiration bucket when parseable. */
  expirationKey: string | null;
}

export interface AdjustedSimilarity {
  raw: number;
  adjusted: number;
  method: MatchScoreMethod;
  sharedNumbers: string[];
  sharedKeywords: string[];
  sameExpirationPeriod: boolean;
}

const MONTH_TO_NUM: Record<string, string> = {
  january: "01",
  jan: "01",
  february: "02",
  feb: "02",
  march: "03",
  mar: "03",
  april: "04",
  apr: "04",
  may: "05",
  june: "06",
  jun: "06",
  july: "07",
  jul: "07",
  august: "08",
  aug: "08",
  september: "09",
  sep: "09",
  sept: "09",
  october: "10",
  oct: "10",
  november: "11",
  nov: "11",
  december: "12",
  dec: "12",
};

const ENTITY_PATTERNS: Array<{ pattern: RegExp; canonical: string }> = [
  { pattern: /\bbitcoin\b|\bbtc\b/gi, canonical: "btc" },
  { pattern: /\bethereum\b|\beth\b/gi, canonical: "eth" },
  { pattern: /\bfederal reserve\b|\bfomc\b|\bfed\b/gi, canonical: "fed" },
  { pattern: /\bcpi\b|\bconsumer price index\b/gi, canonical: "cpi" },
  { pattern: /\bgdp\b/gi, canonical: "gdp" },
  { pattern: /\binflation\b/gi, canonical: "inflation" },
  { pattern: /\bunemployment\b|\bjobs report\b/gi, canonical: "unemployment" },
  { pattern: /\brate cut\b|\bcuts rates\b/gi, canonical: "rate_cut" },
  { pattern: /\brate hike\b|\braise rates\b/gi, canonical: "rate_hike" },
  { pattern: /\bnfl\b|\bpro football\b/gi, canonical: "nfl" },
  { pattern: /\bnba\b|\bpro basketball\b/gi, canonical: "nba" },
  { pattern: /\bmlb\b|\bpro baseball\b/gi, canonical: "mlb" },
  { pattern: /\bnhl\b|\bpro hockey\b/gi, canonical: "nhl" },
  { pattern: /\bworld cup\b|\bcricket\b|\bt20\b|\bicc\b/gi, canonical: "world_cup" },
  { pattern: /\btrump\b/gi, canonical: "trump" },
  { pattern: /\bbiden\b/gi, canonical: "biden" },
  { pattern: /\brecession\b/gi, canonical: "recession" },
  { pattern: /\btariff\b/gi, canonical: "tariff" },
  { pattern: /\binterest rate\b/gi, canonical: "interest_rate" },
];

function normalizeNumberToken(raw: string): string {
  const n = parseFloat(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return raw;
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10000) / 10000);
}

function addNumber(set: Set<string>, value: string): void {
  const normalized = normalizeNumberToken(value);
  if (!normalized) return;
  set.add(normalized);
  const n = parseFloat(normalized);
  if (Number.isFinite(n) && n > 1 && n <= 100) {
    set.add(String(n / 100));
  }
}

function matchAllToArray(text: string, pattern: RegExp): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    results.push(match);
  }
  return results;
}

function extractNumbers(text: string): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();

  for (const match of matchAllToArray(
    lower,
    /(\d+(?:,\d{3})*(?:\.\d+)?)\s*%/g
  )) {
    addNumber(found, match[1].replace(/,/g, ""));
  }

  for (const match of matchAllToArray(lower, /\b(\d+(?:\.\d+)?)\s*([kmb])\b/gi)) {
    const base = parseFloat(match[1]);
    if (!Number.isFinite(base)) continue;
    const suffix = match[2].toLowerCase();
    const mult = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1_000_000_000;
    addNumber(found, String(Math.round(base * mult)));
  }

  for (const match of matchAllToArray(
    lower,
    /\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)/g
  )) {
    const digits = match[1].replace(/,/g, "");
    if (digits.length >= 2) addNumber(found, digits);
  }

  return Array.from(found);
}

const VS_TITLE =
  /\b([a-z][a-z\s'’.\-]{1,40}?)\s+(?:vs\.?|versus|v\.?)\s+([a-z][a-z\s'’.\-]{1,40}?)\b/i;

function extractTeamKeywords(text: string): string[] {
  const teams: string[] = [];
  const vs = text.match(VS_TITLE);
  if (vs) {
    const a = countryNameToPm(vs[1]);
    const b = countryNameToPm(vs[2]);
    if (a) teams.push(`team:${a}`);
    if (b) teams.push(`team:${b}`);
  }
  return teams;
}

function extractKeywords(text: string): string[] {
  const keywords = new Set<string>();
  const lower = text.toLowerCase();

  for (const team of extractTeamKeywords(lower)) {
    keywords.add(team);
  }

  for (const { pattern, canonical } of ENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(lower)) keywords.add(canonical);
  }

  for (const match of matchAllToArray(
    lower,
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi
  )) {
    const key = match[1].toLowerCase();
    keywords.add(`month:${MONTH_TO_NUM[key] ?? key}`);
  }

  for (const match of matchAllToArray(lower, /\b(20\d{2})\b/g)) {
    keywords.add(`year:${match[1]}`);
  }

  return Array.from(keywords);
}

function parseExpirationKey(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}`;
}

function expirationKeyFromText(text: string): string | null {
  const lower = text.toLowerCase();
  const yearMatch = lower.match(/\b(20\d{2})\b/);
  const monthMatch = lower.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i
  );
  if (!yearMatch || !monthMatch) return null;
  const month = MONTH_TO_NUM[monthMatch[1].toLowerCase()];
  if (!month) return null;
  return `${yearMatch[1]}-${month}`;
}

export function extractContractTokens(
  contract: NormalizedMarketContract
): ContractTokens {
  const corpus = `${contract.title}\n${contract.description}`.trim();
  return {
    numbers: extractNumbers(corpus),
    keywords: extractKeywords(corpus),
    expirationKey:
      parseExpirationKey(contract.expiration) ?? expirationKeyFromText(corpus),
  };
}

function intersect(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

export function sameExpirationPeriod(
  a: ContractTokens,
  b: ContractTokens
): boolean {
  if (a.expirationKey && b.expirationKey) {
    return a.expirationKey === b.expirationKey;
  }

  const monthsA = a.keywords.filter((k) => k.startsWith("month:"));
  const monthsB = b.keywords.filter((k) => k.startsWith("month:"));
  const yearsA = a.keywords.filter((k) => k.startsWith("year:"));
  const yearsB = b.keywords.filter((k) => k.startsWith("year:"));

  if (monthsA.length === 0 || monthsB.length === 0) return false;

  const sharedMonths = intersect(monthsA, monthsB);
  if (sharedMonths.length === 0) return false;

  if (yearsA.length > 0 && yearsB.length > 0) {
    return intersect(yearsA, yearsB).length > 0;
  }

  return true;
}

function sharedTeamKeywords(
  pm: ContractTokens,
  kalshi: ContractTokens
): string[] {
  const pmTeams = pm.keywords.filter((k) => k.startsWith("team:"));
  const kalshiTeams = kalshi.keywords.filter((k) => k.startsWith("team:"));
  return intersect(pmTeams, kalshiTeams);
}

function matchesSportsTokenHeuristic(
  pm: ContractTokens,
  kalshi: ContractTokens,
  sharedNumbers: string[],
  sharedKeywords: string[]
): boolean {
  const sharedTeams = sharedTeamKeywords(pm, kalshi);
  if (sharedTeams.length >= 2 && sharedNumbers.length >= 1) return true;
  if (sharedTeams.length >= 2 && sharedKeywords.includes("world_cup")) {
    return true;
  }

  const sharedSports = sharedKeywords.filter(
    (k) => SPORTS_LEAGUE_KEYWORDS.has(k) || k.startsWith("team:")
  );
  if (sharedSports.length >= 2 && sharedNumbers.length >= 1) return true;

  return false;
}

function matchesTokenHeuristic(
  pm: ContractTokens,
  kalshi: ContractTokens,
  sharedNumbers: string[],
  sharedKeywords: string[]
): boolean {
  if (matchesSportsTokenHeuristic(pm, kalshi, sharedNumbers, sharedKeywords)) {
    return true;
  }

  if (!sameExpirationPeriod(pm, kalshi)) return false;
  if (sharedNumbers.length >= 1 && sharedKeywords.length >= 1) return true;
  if (sharedKeywords.length >= 2 && sharedNumbers.length >= 1) return true;
  return false;
}

export function adjustSimilarityWithTokens(
  rawSimilarity: number,
  pmTokens: ContractTokens,
  kalshiTokens: ContractTokens
): AdjustedSimilarity {
  const sharedNumbers = intersect(pmTokens.numbers, kalshiTokens.numbers);
  const sharedKeywords = intersect(pmTokens.keywords, kalshiTokens.keywords);
  const samePeriod = sameExpirationPeriod(pmTokens, kalshiTokens);

  if (matchesSportsTokenHeuristic(pmTokens, kalshiTokens, sharedNumbers, sharedKeywords)) {
    return {
      raw: rawSimilarity,
      adjusted: Math.min(
        1,
        Math.max(
          rawSimilarity + TOKEN_SIMILARITY_BOOST,
          TOKEN_HEURISTIC_OVERRIDE_SCORE
        )
      ),
      method: "token_heuristic",
      sharedNumbers,
      sharedKeywords,
      sameExpirationPeriod: samePeriod,
    };
  }

  if (
    matchesTokenHeuristic(pmTokens, kalshiTokens, sharedNumbers, sharedKeywords)
  ) {
    return {
      raw: rawSimilarity,
      adjusted: Math.min(
        1,
        Math.max(
          rawSimilarity + TOKEN_SIMILARITY_BOOST,
          TOKEN_HEURISTIC_OVERRIDE_SCORE
        )
      ),
      method: "token_heuristic",
      sharedNumbers,
      sharedKeywords,
      sameExpirationPeriod: samePeriod,
    };
  }

  const hasNumericOverlap = sharedNumbers.length > 0;
  const hasKeywordOverlap = sharedKeywords.length > 0;

  if (samePeriod && hasNumericOverlap && hasKeywordOverlap) {
    return {
      raw: rawSimilarity,
      adjusted: Math.min(1, rawSimilarity + TOKEN_SIMILARITY_BOOST),
      method: "token_boost",
      sharedNumbers,
      sharedKeywords,
      sameExpirationPeriod: true,
    };
  }

  if (hasKeywordOverlap && sharedKeywords.length >= 2) {
    return {
      raw: rawSimilarity,
      adjusted: Math.min(1, rawSimilarity + TOKEN_SIMILARITY_BOOST * 0.5),
      method: "token_boost",
      sharedNumbers,
      sharedKeywords,
      sameExpirationPeriod: samePeriod,
    };
  }

  const sharedCrypto = sharedKeywords.filter((k) => CRYPTO_ASSET_KEYWORDS.has(k));
  if (sharedCrypto.length >= 1 && rawSimilarity >= 0.55) {
    return {
      raw: rawSimilarity,
      adjusted: Math.min(1, rawSimilarity + TOKEN_SIMILARITY_BOOST),
      method: "token_boost",
      sharedNumbers,
      sharedKeywords,
      sameExpirationPeriod: samePeriod,
    };
  }

  const sharedSports = sharedKeywords.filter((k) =>
    SPORTS_LEAGUE_KEYWORDS.has(k)
  );
  const sharedTeams = sharedTeamKeywords(pmTokens, kalshiTokens);
  if (
    (sharedSports.length >= 1 || sharedTeams.length >= 2) &&
    rawSimilarity >= 0.52
  ) {
    return {
      raw: rawSimilarity,
      adjusted: Math.min(1, rawSimilarity + TOKEN_SIMILARITY_BOOST * 0.75),
      method: "token_boost",
      sharedNumbers,
      sharedKeywords,
      sameExpirationPeriod: samePeriod,
    };
  }

  const sharedMacro = sharedKeywords.filter((k) =>
    MACRO_ENTITY_KEYWORDS.has(k)
  );
  if (sharedMacro.length >= 1 && rawSimilarity >= 0.6) {
    return {
      raw: rawSimilarity,
      adjusted: Math.min(1, rawSimilarity + TOKEN_SIMILARITY_BOOST * 0.75),
      method: "token_boost",
      sharedNumbers,
      sharedKeywords,
      sameExpirationPeriod: samePeriod,
    };
  }

  return {
    raw: rawSimilarity,
    adjusted: rawSimilarity,
    method: "vector",
    sharedNumbers,
    sharedKeywords,
    sameExpirationPeriod: samePeriod,
  };
}

/** True when a pair shares entity tokens — used to gate low-threshold passes. */
export function hasCrossMarketTokenEvidence(
  pmTokens: ContractTokens,
  kalshiTokens: ContractTokens,
  method: MatchScoreMethod
): boolean {
  if (method !== "vector") return true;

  const sharedKeywords = intersect(pmTokens.keywords, kalshiTokens.keywords);
  const sharedNumbers = intersect(pmTokens.numbers, kalshiTokens.numbers);

  if (sharedTeamKeywords(pmTokens, kalshiTokens).length >= 2) return true;
  if (sharedKeywords.includes("world_cup")) return true;
  if (sharedKeywords.length >= 1) return true;
  if (sharedNumbers.length >= 1 && sharedKeywords.length >= 1) return true;

  return false;
}

export interface ScoredCandidatePair {
  pmIndex: number;
  kalshiIndex: number;
  rawScore: number;
  adjustedScore: number;
  method: MatchScoreMethod;
}

export function buildAllScoredPairs(
  pmVectors: number[][],
  kalshiVectors: number[][],
  pmTokens: ContractTokens[],
  kalshiTokens: ContractTokens[],
  cosineSimilarity: (a: number[], b: number[]) => number,
  polymarket: NormalizedMarketContract[] = [],
  kalshi: NormalizedMarketContract[] = []
): ScoredCandidatePair[] {
  const pairs: ScoredCandidatePair[] = [];

  for (let i = 0; i < pmVectors.length; i++) {
    for (let j = 0; j < kalshiVectors.length; j++) {
      if (
        polymarket.length > 0 &&
        kalshi.length > 0 &&
        (!contractsMappingCompatible(polymarket[i], kalshi[j]) ||
          !contractsSportsMarketTypeCompatible(polymarket[i], kalshi[j]))
      ) {
        continue;
      }

      const raw = cosineSimilarity(pmVectors[i], kalshiVectors[j]);
      const adjusted = adjustSimilarityWithTokens(
        raw,
        pmTokens[i],
        kalshiTokens[j]
      );
      pairs.push({
        pmIndex: i,
        kalshiIndex: j,
        rawScore: raw,
        adjustedScore: adjusted.adjusted,
        method: adjusted.method,
      });
    }
  }

  pairs.sort((a, b) => b.adjustedScore - a.adjustedScore);
  return pairs;
}

export function bestCandidatePerPm(
  pairs: ScoredCandidatePair[]
): ScoredCandidatePair[] {
  const best = new Map<number, ScoredCandidatePair>();

  for (const pair of pairs) {
    const existing = best.get(pair.pmIndex);
    if (!existing || pair.adjustedScore > existing.adjustedScore) {
      best.set(pair.pmIndex, pair);
    }
  }

  return Array.from(best.values()).sort((a, b) => b.adjustedScore - a.adjustedScore);
}

export interface GreedyMatchOptions {
  forceMethod?: MatchScoreMethod;
  requireTokenEvidence?: boolean;
  pmTokens?: ContractTokens[];
  kalshiTokens?: ContractTokens[];
}

export function greedyMatchFromPairs(
  pairs: ScoredCandidatePair[],
  threshold: number,
  polymarket: NormalizedMarketContract[],
  kalshi: NormalizedMarketContract[],
  options: GreedyMatchOptions = {}
): Array<{
  pair: MatchedPairShape;
  method: MatchScoreMethod;
}> {
  const { forceMethod, requireTokenEvidence, pmTokens, kalshiTokens } =
    options;
  const matches: Array<{ pair: MatchedPairShape; method: MatchScoreMethod }> =
    [];
  const usedPm = new Set<number>();
  const usedKalshi = new Set<number>();

  for (const row of pairs) {
    if (row.adjustedScore < threshold) continue;
    if (
      requireTokenEvidence &&
      pmTokens &&
      kalshiTokens &&
      !hasCrossMarketTokenEvidence(
        pmTokens[row.pmIndex],
        kalshiTokens[row.kalshiIndex],
        row.method
      )
    ) {
      continue;
    }
    if (usedPm.has(row.pmIndex) || usedKalshi.has(row.kalshiIndex)) continue;

    const pm = polymarket[row.pmIndex];
    const km = kalshi[row.kalshiIndex];
    if (
      !contractsMappingCompatible(pm, km) ||
      !contractsSportsMarketTypeCompatible(pm, km)
    ) {
      continue;
    }

    usedPm.add(row.pmIndex);
    usedKalshi.add(row.kalshiIndex);

    matches.push({
      method: forceMethod ?? row.method,
      pair: {
        polymarketTokenId: pm.tokenOrTicker,
        polymarketConditionId: pm.externalId,
        kalshiTicker: km.tokenOrTicker,
        similarity: round(row.adjustedScore),
        rawSimilarity: round(row.rawScore),
        polymarketTitle: pm.title,
        kalshiTitle: km.title,
        matchMethod: forceMethod ?? row.method,
      },
    });
  }

  return matches;
}

export function testFallbackTopPairs(
  pairs: ScoredCandidatePair[],
  polymarket: NormalizedMarketContract[],
  kalshi: NormalizedMarketContract[],
  count = 2
): Array<{ pair: MatchedPairShape; method: MatchScoreMethod }> {
  const selected: Array<{ pair: MatchedPairShape; method: MatchScoreMethod }> =
    [];
  const usedPm = new Set<number>();
  const usedKalshi = new Set<number>();

  for (const row of pairs) {
    if (selected.length >= count) break;
    if (usedPm.has(row.pmIndex) || usedKalshi.has(row.kalshiIndex)) continue;

    usedPm.add(row.pmIndex);
    usedKalshi.add(row.kalshiIndex);

    const pm = polymarket[row.pmIndex];
    const km = kalshi[row.kalshiIndex];
    selected.push({
      method: "TEST_FALLBACK_PAIR",
      pair: {
        polymarketTokenId: pm.tokenOrTicker,
        polymarketConditionId: pm.externalId,
        kalshiTicker: km.tokenOrTicker,
        similarity: round(row.adjustedScore),
        rawSimilarity: round(row.rawScore),
        polymarketTitle: pm.title,
        kalshiTitle: km.title,
        matchMethod: "TEST_FALLBACK_PAIR",
      },
    });
  }

  return selected;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Internal shape before MapMarketsResult mapping. */
export interface MatchedPairShape {
  polymarketTokenId: string;
  polymarketConditionId: string;
  kalshiTicker: string;
  similarity: number;
  rawSimilarity?: number;
  polymarketTitle: string;
  kalshiTitle: string;
  matchMethod: MatchScoreMethod | string;
}
