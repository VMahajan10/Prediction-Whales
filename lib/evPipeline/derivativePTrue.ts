import {
  createGameAnchorStore,
  deriveSportsDerivativePTrue,
  parseSportsDerivativeFromMapping,
  sortMappingsForSportsAnchors,
  updateGameAnchorFromPrimary,
  type DeriveSportsPTrueResult,
  type SportsDerivativeSpec,
} from "@/lib/evPipeline/sportsDerivativePTrue";

export type DerivativeMarketClass = "sports" | "financial" | "politics" | "other";

export type FinancialDirection = "above" | "below" | "between";

export interface DerivativeMappingInput {
  polymarketTokenId?: string;
  polymarketTitle: string;
  kalshiTitle: string;
  kalshiTicker: string;
  slug?: string | null;
  eventSlug?: string | null;
}

export interface FinancialDerivativeDetail {
  entity: string;
  strike: number | null;
  direction: FinancialDirection | null;
  bracketLow: number | null;
  bracketHigh: number | null;
  unit: "usd" | "percent" | "index";
}

export interface PoliticsDerivativeDetail {
  entity: string;
  kind: "winner" | "bracket" | "conditional" | "margin";
  bracketLow: number | null;
  bracketHigh: number | null;
  conditionLabel: string | null;
}

export interface UnifiedDerivativeSpec {
  marketClass: DerivativeMarketClass;
  eventKey: string;
  isPrimary: boolean;
  sports: SportsDerivativeSpec | null;
  financial: FinancialDerivativeDetail | null;
  politics: PoliticsDerivativeDetail | null;
}

export interface FinancialAnchor {
  eventKey: string;
  entity: string;
  primaryStrike: number;
  primaryDirection: "above" | "below";
  primaryPTrue: number;
  volatility: number;
  unit: "usd" | "percent" | "index";
}

export interface PoliticsAnchor {
  eventKey: string;
  entity: string;
  primaryPTrue: number;
  kind: "winner" | "nomination";
}

export interface DerivativeAnchorStore {
  sports: ReturnType<typeof createGameAnchorStore>;
  financial: Map<string, FinancialAnchor>;
  politics: Map<string, PoliticsAnchor>;
}

export interface DeriveDerivativePTrueResult extends DeriveSportsPTrueResult {
  marketClass: DerivativeMarketClass;
}

const FINANCIAL_ENTITY_PATTERNS: Array<{ re: RegExp; entity: string; unit: FinancialDerivativeDetail["unit"] }> = [
  { re: /\bbitcoin\b|\bbtc\b/i, entity: "btc", unit: "usd" },
  { re: /\bethereum\b|\beth\b/i, entity: "eth", unit: "usd" },
  { re: /\bsolana\b|\bsol\b/i, entity: "sol", unit: "usd" },
  { re: /\bxrp\b|\bripple\b/i, entity: "xrp", unit: "usd" },
  { re: /\bfed\b|\bfomc\b|\binterest rate\b|\brate cut\b|\brate hike\b/i, entity: "fed", unit: "percent" },
  { re: /\bcpi\b|\binflation\b/i, entity: "cpi", unit: "percent" },
  { re: /\bgdp\b/i, entity: "gdp", unit: "percent" },
  { re: /\bunemployment\b|\bjobs report\b/i, entity: "unemployment", unit: "percent" },
  { re: /\brecession\b/i, entity: "recession", unit: "index" },
  { re: /\btariff\b/i, entity: "tariff", unit: "index" },
];

const POLITICS_ENTITY_PATTERNS: Array<{ re: RegExp; entity: string }> = [
  { re: /\btrump\b/i, entity: "trump" },
  { re: /\bbiden\b/i, entity: "biden" },
  { re: /\bharris\b/i, entity: "harris" },
  { re: /\bdemocrat\b|\bdemocratic\b/i, entity: "democrat" },
  { re: /\brepublican\b|\bgop\b/i, entity: "republican" },
];

const DEFAULT_FINANCIAL_VOL: Record<string, number> = {
  btc: 0.22,
  eth: 0.28,
  sol: 0.35,
  xrp: 0.35,
  fed: 0.08,
  cpi: 0.06,
  gdp: 0.05,
  unemployment: 0.05,
  recession: 0.12,
  tariff: 0.1,
};

function clampProb(p: number): number {
  return Math.max(0.001, Math.min(0.999, p));
}

function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const prob =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - prob : prob;
}

function normalInv(p: number): number {
  const clamped = clampProb(p);
  const a1 = -39.6968302866538;
  const a2 = 220.946098424521;
  const a3 = -275.928510446969;
  const a4 = 138.357751867269;
  const a5 = -30.6647980661472;
  const a6 = 2.50662827745924;
  const b1 = -54.4760987982241;
  const b2 = 161.585836858041;
  const b3 = -155.698979859887;
  const b4 = 66.8013118877193;
  const b5 = -13.2806815528857;
  const c1 = -7.78489400243029e-3;
  const c2 = -0.322396458077136;
  const c3 = -2.40075827716184;
  const c4 = -2.54973253934373;
  const c5 = 4.37466414146497;
  const c6 = 2.93816398269878;
  const d1 = 7.78469570904146e-3;
  const d2 = 0.32246712907004;
  const d3 = 2.445134137143;
  const d4 = 3.75440866190742;
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number;
  let r: number;
  if (clamped < plow) {
    q = Math.sqrt(-2 * Math.log(clamped));
    return (
      (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
    );
  }
  if (clamped > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - clamped));
    return -(
      (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
    );
  }
  q = clamped - 0.5;
  r = q * q;
  return (
    (((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q /
    (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1)
  );
}

function corpusText(input: DerivativeMappingInput): string {
  return `${input.slug ?? ""} ${input.eventSlug ?? ""} ${input.polymarketTitle} ${input.kalshiTitle} ${input.kalshiTicker}`.toLowerCase();
}

function extractExpirationKey(text: string): string {
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const monthYear = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(20\d{2})\b/i
  );
  if (monthYear) return `${monthYear[2]}-${monthYear[1].slice(0, 3).toLowerCase()}`;
  const yearOnly = text.match(/\b(20\d{2})\b/);
  if (yearOnly) return yearOnly[1];
  const kalshiMid = text.match(/\b(\d{2})(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(\d{2})\b/i);
  if (kalshiMid) return `20${kalshiMid[1]}-${kalshiMid[2]}`;
  return "unknown";
}

function parseKalshiStrike(ticker: string): number | null {
  for (const part of ticker.split("-")) {
    if (/^T\d/.test(part)) {
      const n = parseFloat(part.slice(1));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function parseNumericToken(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
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

function extractStrikeFromText(text: string): number | null {
  const lower = text.toLowerCase();

  for (const match of matchAllToArray(
    lower,
    /\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?:k|m|b)?\b/gi
  )) {
    const raw = match[1].replace(/,/g, "");
    const suffix = match[0].trim().slice(-1).toLowerCase();
    let n = parseFloat(raw);
    if (!Number.isFinite(n)) continue;
    if (suffix === "k") n *= 1_000;
    if (suffix === "m") n *= 1_000_000;
    if (suffix === "b") n *= 1_000_000_000;
    if (n >= 1) return n;
  }

  for (const match of matchAllToArray(lower, /\b(\d+(?:\.\d+)?)\s*%/g)) {
    const n = parseFloat(match[1]);
    if (Number.isFinite(n)) return n;
  }

  for (const match of matchAllToArray(
    lower,
    /\b(\d+(?:\.\d+)?)\s*(?:bps|basis points?)\b/gi
  )) {
    const n = parseFloat(match[1]);
    if (Number.isFinite(n)) return n / 100;
  }

  return null;
}

function extractBracket(text: string): { low: number; high: number } | null {
  const m = text.match(/\b(\d+(?:\.\d+)?)\s*(?:%|pts?|points?|seats?|votes?)?\s*[-–to]+\s*(\d+(?:\.\d+)?)\b/i);
  if (!m) return null;
  const low = parseNumericToken(m[1]);
  const high = parseNumericToken(m[2]);
  if (low == null || high == null) return null;
  return { low: Math.min(low, high), high: Math.max(low, high) };
}

function inferFinancialDirection(text: string): FinancialDirection | null {
  if (/\bbetween\b|\brange\b|\bbracket\b/.test(text)) return "between";
  if (/\bbelow\b|\bunder\b|\bless than\b|\blower than\b|\bdrop below\b/.test(text)) {
    return "below";
  }
  if (/\babove\b|\bover\b|\bat least\b|\breach\b|\bexceed\b|\bhigher than\b|\bgreater than\b/.test(text)) {
    return "above";
  }
  return null;
}

function detectFinancialEntity(text: string): FinancialDerivativeDetail | null {
  for (const { re, entity, unit } of FINANCIAL_ENTITY_PATTERNS) {
    if (!re.test(text)) continue;
    const bracket = extractBracket(text);
    const strike =
      parseKalshiStrike(text) ??
      extractStrikeFromText(text) ??
      (bracket ? bracket.low : null);
    const direction = inferFinancialDirection(text);
    return {
      entity,
      strike,
      direction,
      bracketLow: bracket?.low ?? null,
      bracketHigh: bracket?.high ?? null,
      unit,
    };
  }
  return null;
}

function detectPoliticsEntity(text: string): string | null {
  for (const { re, entity } of POLITICS_ENTITY_PATTERNS) {
    if (re.test(text)) return entity;
  }
  if (/president|presidential|election|senate|congress|governor|primary|nominee|electoral|house/.test(text)) {
    return "election";
  }
  return null;
}

function inferPoliticsKind(text: string): PoliticsDerivativeDetail["kind"] {
  if (/\bif\b|\bgiven\b|\bconditional\b|\bassuming\b/.test(text)) return "conditional";
  if (extractBracket(text)) return "bracket";
  if (/\bmargin\b|\bby \d+\s*(?:points?|votes?|seats?|%)/.test(text)) return "margin";
  return "winner";
}

function detectPoliticsDetail(text: string, entity: string): PoliticsDerivativeDetail {
  const bracket = extractBracket(text);
  const kind = inferPoliticsKind(text);
  let conditionLabel: string | null = null;
  const cond = text.match(/\bif\s+(.{3,60}?)(?:\?|,|$)/i);
  if (cond) conditionLabel = cond[1].trim();

  return {
    entity,
    kind,
    bracketLow: bracket?.low ?? null,
    bracketHigh: bracket?.high ?? null,
    conditionLabel,
  };
}

/** Classify a mapped contract into sports / financial / politics / other. */
export function detectDerivativeMarketClass(
  input: DerivativeMappingInput
): DerivativeMarketClass {
  const text = corpusText(input);
  const sports = parseSportsDerivativeFromMapping(input);
  if (sports) return "sports";
  if (detectFinancialEntity(text)) return "financial";
  if (detectPoliticsEntity(text)) return "politics";
  if (/\d/.test(text)) return "other";
  return "other";
}

function buildFinancialEventKey(entity: string, text: string, ticker: string): string {
  const series = ticker.split("-")[0]?.toUpperCase() ?? entity;
  return `fin:${entity}:${extractExpirationKey(text)}:${series}`;
}

function buildPoliticsEventKey(entity: string, text: string, ticker: string): string {
  const series = ticker.split("-")[0]?.toUpperCase() ?? "event";
  return `pol:${entity}:${extractExpirationKey(text)}:${series}`;
}

function isSportsPrimary(spec: SportsDerivativeSpec): boolean {
  return spec.kind === "moneyline";
}

function isFinancialPrimary(detail: FinancialDerivativeDetail, text: string): boolean {
  if (detail.bracketLow != null && detail.direction === "between") return false;
  if (/\bbracket\b|\bbetween\b/.test(text) && detail.direction === "between") return false;
  if (detail.direction === "between") return false;
  return detail.strike != null;
}

function isPoliticsPrimary(detail: PoliticsDerivativeDetail): boolean {
  return detail.kind === "winner" || detail.kind === "margin";
}

/** Parse any mapped PM↔Kalshi pair into a unified derivative specification. */
export function parseDerivativeFromMapping(
  input: DerivativeMappingInput
): UnifiedDerivativeSpec | null {
  const text = corpusText(input);
  const sports = parseSportsDerivativeFromMapping(input);
  if (sports) {
    return {
      marketClass: "sports",
      eventKey: sports.gameId,
      isPrimary: isSportsPrimary(sports),
      sports,
      financial: null,
      politics: null,
    };
  }

  const financial = detectFinancialEntity(text);
  if (financial) {
    return {
      marketClass: "financial",
      eventKey: buildFinancialEventKey(financial.entity, text, input.kalshiTicker),
      isPrimary: isFinancialPrimary(financial, text),
      sports: null,
      financial,
      politics: null,
    };
  }

  const politicsEntity = detectPoliticsEntity(text);
  if (politicsEntity) {
    const politics = detectPoliticsDetail(text, politicsEntity);
    return {
      marketClass: "politics",
      eventKey: buildPoliticsEventKey(politicsEntity, text, input.kalshiTicker),
      isPrimary: isPoliticsPrimary(politics),
      sports: null,
      financial: null,
      politics,
    };
  }

  const strike = parseKalshiStrike(input.kalshiTicker) ?? extractStrikeFromText(text);
  if (strike != null) {
    const direction = inferFinancialDirection(text) ?? "above";
    return {
      marketClass: "other",
      eventKey: `other:${extractExpirationKey(text)}:${input.kalshiTicker.split("-")[0] ?? "x"}`,
      isPrimary: true,
      sports: null,
      financial: {
        entity: "generic",
        strike,
        direction,
        bracketLow: null,
        bracketHigh: null,
        unit: strike <= 100 ? "percent" : "usd",
      },
      politics: null,
    };
  }

  return null;
}

export function createDerivativeAnchorStore(): DerivativeAnchorStore {
  return {
    sports: createGameAnchorStore(),
    financial: new Map(),
    politics: new Map(),
  };
}

function defaultFinancialVol(entity: string, unit: FinancialDerivativeDetail["unit"]): number {
  if (DEFAULT_FINANCIAL_VOL[entity]) return DEFAULT_FINANCIAL_VOL[entity];
  return unit === "percent" ? 0.07 : unit === "usd" ? 0.25 : 0.1;
}

function financialTailProbability(
  anchor: FinancialAnchor,
  strike: number,
  direction: "above" | "below"
): number {
  let z0 = normalInv(anchor.primaryDirection === "above" ? anchor.primaryPTrue : 1 - anchor.primaryPTrue);

  let shift: number;
  if (anchor.unit === "usd" && anchor.primaryStrike > 0 && strike > 0) {
    shift = Math.log(strike / anchor.primaryStrike) / anchor.volatility;
  } else {
    shift = (strike - anchor.primaryStrike) / (anchor.volatility * 100);
  }

  let z = z0 - shift;
  if (direction === "below") z = -z;
  if (anchor.primaryDirection === "below") z = -z;

  return clampProb(normalCdf(z));
}

function deriveFinancialPTrue(
  spec: UnifiedDerivativeSpec,
  store: DerivativeAnchorStore,
  marketPrior: number
): DeriveDerivativePTrueResult | null {
  const detail = spec.financial;
  if (!detail) return null;
  const anchor = store.financial.get(spec.eventKey);
  if (!anchor) return null;

  const direction =
    detail.direction === "below"
      ? "below"
      : detail.direction === "above"
        ? "above"
        : anchor.primaryDirection;

  if (
    detail.bracketLow != null &&
    detail.bracketHigh != null &&
    detail.direction === "between"
  ) {
    const pAboveLo = financialTailProbability(anchor, detail.bracketLow, "above");
    const pAboveHi = financialTailProbability(anchor, detail.bracketHigh, "above");
    const mass = clampProb(pAboveLo - pAboveHi);
    return {
      marketClass: "financial",
      pTrue: mass,
      method: "financial_bracket_interp",
      detail: `bracket=${detail.bracketLow}-${detail.bracketHigh} entity=${detail.entity}`,
    };
  }

  if (detail.strike == null) return null;

  const pTrue = financialTailProbability(anchor, detail.strike, direction);
  return {
    marketClass: "financial",
    pTrue,
    method: "financial_vol_interp",
    detail: `strike=${detail.strike} entity=${detail.entity} vol=${anchor.volatility.toFixed(3)}`,
  };
}

function bracketMass(mean: number, lo: number, hi: number, sigma: number): number {
  const zLo = (lo - mean) / sigma;
  const zHi = (hi - mean) / sigma;
  return clampProb(normalCdf(zHi) - normalCdf(zLo));
}

function derivePoliticsPTrue(
  spec: UnifiedDerivativeSpec,
  store: DerivativeAnchorStore,
  marketPrior: number
): DeriveDerivativePTrueResult | null {
  const detail = spec.politics;
  if (!detail) return null;
  const anchor = store.politics.get(spec.eventKey);
  if (!anchor) return null;

  const nationalMean = clampProb(0.5 + (anchor.primaryPTrue - 0.5) * 0.85);

  if (detail.kind === "bracket" && detail.bracketLow != null) {
    const lo = detail.bracketLow;
    const hi = detail.bracketHigh ?? detail.bracketLow;
    const scale = hi > 100 ? 538 : hi > 50 ? 100 : 1;
    const mean = nationalMean * scale;
    const sigma = scale * 0.12;
    const pTrue = bracketMass(mean, lo, hi, sigma);
    return {
      marketClass: "politics",
      pTrue,
      method: "politics_bracket_tree",
      detail: `bracket=${lo}-${hi} entity=${detail.entity}`,
    };
  }

  if (detail.kind === "conditional") {
    const swingFactor = 0.52 + 0.35 * (anchor.primaryPTrue - 0.5);
    const pTrue = clampProb(anchor.primaryPTrue * clampProb(swingFactor));
    return {
      marketClass: "politics",
      pTrue,
      method: "politics_conditional_tree",
      detail: `condition=${detail.conditionLabel ?? "state"} entity=${detail.entity}`,
    };
  }

  if (detail.kind === "margin") {
    const marginMean = (anchor.primaryPTrue - 0.5) * 20;
    const strike = detail.bracketLow ?? 0;
    const pTrue = clampProb(normalCdf((marginMean - strike) / 4));
    return {
      marketClass: "politics",
      pTrue,
      method: "politics_margin_tree",
      detail: `margin=${strike} entity=${detail.entity}`,
    };
  }

  return null;
}

function deriveOtherPTrue(
  spec: UnifiedDerivativeSpec,
  store: DerivativeAnchorStore,
  marketPrior: number
): DeriveDerivativePTrueResult | null {
  if (spec.financial) {
    const asFinancial: UnifiedDerivativeSpec = { ...spec, marketClass: "financial" };
    const result = deriveFinancialPTrue(asFinancial, store, marketPrior);
    if (result) return { ...result, marketClass: "other" };
  }
  return null;
}

/** Record ensemble / primary output to anchor sibling derivatives. */
export function updateDerivativeAnchorFromPrimary(
  store: DerivativeAnchorStore,
  spec: UnifiedDerivativeSpec,
  pTrue: number,
  marketPrior: number
): void {
  if (spec.marketClass === "sports" && spec.sports) {
    updateGameAnchorFromPrimary(store.sports, spec.sports, pTrue, marketPrior);
    return;
  }

  if (spec.marketClass === "financial" && spec.financial) {
    const { financial } = spec;
    if (financial.strike == null) return;
    const direction =
      financial.direction === "below"
        ? "below"
        : financial.direction === "above"
          ? "above"
          : marketPrior >= 0.5
            ? "above"
            : "below";

    store.financial.set(spec.eventKey, {
      eventKey: spec.eventKey,
      entity: financial.entity,
      primaryStrike: financial.strike,
      primaryDirection: direction,
      primaryPTrue: clampProb(pTrue),
      volatility: defaultFinancialVol(financial.entity, financial.unit),
      unit: financial.unit,
    });
    return;
  }

  if (spec.marketClass === "politics" && spec.politics) {
    store.politics.set(spec.eventKey, {
      eventKey: spec.eventKey,
      entity: spec.politics.entity,
      primaryPTrue: clampProb(pTrue),
      kind: spec.politics.kind === "winner" ? "winner" : "nomination",
    });
    return;
  }

  if (spec.marketClass === "other" && spec.financial?.strike != null) {
    const asFinancial: UnifiedDerivativeSpec = { ...spec, marketClass: "financial", isPrimary: true };
    updateDerivativeAnchorFromPrimary(store, asFinancial, pTrue, marketPrior);
  }
}

/** Derive p_true for a non-primary derivative using anchored primaries. */
export function deriveDerivativePTrue(
  spec: UnifiedDerivativeSpec,
  store: DerivativeAnchorStore,
  marketPrior: number
): DeriveDerivativePTrueResult | null {
  if (spec.marketClass === "sports" && spec.sports) {
    const sports = deriveSportsDerivativePTrue(spec.sports, store.sports, marketPrior);
    if (!sports) return null;
    return { ...sports, marketClass: "sports" };
  }
  if (spec.marketClass === "financial") {
    return deriveFinancialPTrue(spec, store, marketPrior);
  }
  if (spec.marketClass === "politics") {
    return derivePoliticsPTrue(spec, store, marketPrior);
  }
  if (spec.marketClass === "other") {
    return deriveOtherPTrue(spec, store, marketPrior);
  }
  return null;
}

function derivativeSortPriority(spec: UnifiedDerivativeSpec | null): number {
  if (!spec) return 100;
  if (spec.isPrimary) return 0;
  switch (spec.marketClass) {
    case "sports":
      return 10 + (spec.sports ? (spec.sports.kind === "total" ? 1 : 2) : 3);
    case "financial":
      return 20 + (spec.financial?.strike ?? 0) / 1_000_000;
    case "politics":
      return 30;
    default:
      return 40;
  }
}

/** Order mappings so primaries populate anchors before derivative interpolation. */
export function sortMappingsForDerivativePricing<
  T extends DerivativeMappingInput
>(mappings: T[]): T[] {
  const sportsSorted = sortMappingsForSportsAnchors(mappings);
  type SpecRow = { mapping: T; spec: UnifiedDerivativeSpec | null };
  const withSpec: SpecRow[] = sportsSorted.map((m) => ({
    mapping: m,
    spec: parseDerivativeFromMapping(m),
  }));

  const financialGroups = new Map<string, SpecRow[]>();
  for (const row of withSpec) {
    if (row.spec?.marketClass !== "financial" || !row.spec.financial?.strike) continue;
    const group = financialGroups.get(row.spec.eventKey) ?? [];
    group.push(row);
    financialGroups.set(row.spec.eventKey, group);
  }

  for (const group of Array.from(financialGroups.values())) {
    if (group.length <= 1) continue;
    group.sort(
      (a, b) =>
        (a.spec!.financial!.strike ?? 0) - (b.spec!.financial!.strike ?? 0)
    );
    for (let i = 1; i < group.length; i++) {
      if (group[i].spec) group[i].spec!.isPrimary = false;
    }
  }

  return withSpec
    .sort(
      (a, b) =>
        derivativeSortPriority(a.spec) - derivativeSortPriority(b.spec)
    )
    .map((row) => row.mapping);
}
