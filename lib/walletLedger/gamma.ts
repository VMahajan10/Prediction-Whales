import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { mergeOutboundHeaders } from "@/lib/outboundHttp";
import { POLYMARKET_GAMMA_API_BASE } from "@/lib/walletLedger/constants";
import type { GammaMarketResolution } from "@/lib/walletLedger/types";

const JSON_HEADERS = mergeOutboundHeaders({ Accept: "application/json" });
const GAMMA_FETCH_CONCURRENCY = 4;
const GAMMA_INTER_REQUEST_DELAY_MS = 25;

interface GammaMarketRow {
  conditionId?: string;
  question?: string;
  slug?: string;
  closed?: boolean;
  outcomes?: string;
  outcomePrices?: string;
  umaResolutionStatus?: string | null;
  closedTime?: string | null;
  clobTokenIds?: string | string[];
}

export interface MarketResolveHint {
  conditionId: string;
  slugs: string[];
  assets: string[];
}

function normalizeConditionId(conditionId: string): string {
  return conditionId.trim().toLowerCase();
}

function parseJsonArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parsePriceArray(value: string | undefined): number[] {
  return parseJsonArray(value)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
}

function parseTokenIds(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function classifyGammaMarketRow(
  row: GammaMarketRow | null | undefined,
  requestedConditionId: string,
  source: GammaMarketResolution["source"]
): GammaMarketResolution {
  const conditionId = row?.conditionId?.trim() || requestedConditionId;
  const outcomes = parseJsonArray(row?.outcomes);
  const outcomePrices = parsePriceArray(row?.outcomePrices);
  const clobTokenIds = parseTokenIds(row?.clobTokenIds);
  const umaStatus = row?.umaResolutionStatus ?? null;
  const closed = row?.closed === true;
  const marketFound = Boolean(row?.conditionId || row?.slug || row?.question);

  let winningIndex: number | null = null;
  for (let i = 0; i < outcomePrices.length; i += 1) {
    if (outcomePrices[i] >= 0.95) {
      winningIndex = i;
      break;
    }
  }

  const hasBinarySettlement =
    outcomePrices.length >= 2 &&
    Math.max(...outcomePrices) >= 0.95 &&
    Math.min(...outcomePrices) <= 0.05;

  const disputed =
    umaStatus != null &&
    umaStatus !== "" &&
    !/resolved|confirmed|final/i.test(umaStatus);

  let resolutionStatus: GammaMarketResolution["resolutionStatus"] = "open";
  if (!marketFound) resolutionStatus = "missing_metadata";
  else if (disputed) resolutionStatus = "unresolved_or_disputed";
  else if (closed && hasBinarySettlement && winningIndex != null) {
    resolutionStatus = "resolved";
  } else if (closed && winningIndex == null) {
    resolutionStatus = "unresolved_or_disputed";
  } else resolutionStatus = "open";

  const resolutionFinal = resolutionStatus === "resolved";
  let confidence: GammaMarketResolution["confidence"] = "low";
  if (!marketFound) confidence = "low";
  else if (resolutionFinal && closed) confidence = "high";
  else if (resolutionFinal) confidence = "medium";
  else if (resolutionStatus === "open") confidence = "medium";
  else confidence = "low";

  const winningOutcome =
    winningIndex != null ? outcomes[winningIndex] ?? null : null;
  const winningAsset =
    winningIndex != null ? clobTokenIds[winningIndex] ?? null : null;

  return {
    conditionId,
    marketFound,
    closed,
    resolved: resolutionFinal,
    resolutionFinal,
    outcomes,
    outcomePrices,
    winningOutcome,
    winningAsset,
    winningIndex,
    resolvedAt: row?.closedTime ?? null,
    umaResolutionStatus: umaStatus,
    resolutionStatus,
    question: row?.question ?? null,
    slug: row?.slug ?? null,
    clobTokenIds,
    source,
    confidence,
  };
}

async function fetchGammaMarkets(
  query: Record<string, string>,
  attempt = 0
): Promise<GammaMarketRow[]> {
  const params = new URLSearchParams({ ...query, limit: "5" });
  const url = `${POLYMARKET_GAMMA_API_BASE}/markets?${params.toString()}`;
  try {
    const res = await fetchWithTimeout(url, { headers: JSON_HEADERS });
    if (res.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      return fetchGammaMarkets(query, attempt + 1);
    }
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as GammaMarketRow[]) : [];
  } catch {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      return fetchGammaMarkets(query, attempt + 1);
    }
    return [];
  }
}

function pickMatchingRow(
  rows: GammaMarketRow[],
  requestedConditionId: string
): GammaMarketRow | null {
  const normalized = normalizeConditionId(requestedConditionId);
  return (
    rows.find(
      (r) => r.conditionId && normalizeConditionId(r.conditionId) === normalized
    ) ??
    rows[0] ??
    null
  );
}

async function resolveConditionIdOnly(
  hint: MarketResolveHint
): Promise<GammaMarketResolution> {
  const conditionId = hint.conditionId.trim();
  if (!conditionId) return classifyGammaMarketRow(null, "", "missing");

  const byCondition = await fetchGammaMarkets({ condition_ids: conditionId });
  const conditionMatch = pickMatchingRow(byCondition, conditionId);
  if (conditionMatch?.conditionId) {
    return classifyGammaMarketRow(conditionMatch, conditionId, "condition_id");
  }
  return classifyGammaMarketRow(null, conditionId, "missing");
}

async function backfillUnresolved(
  hint: MarketResolveHint,
  existing: GammaMarketResolution
): Promise<GammaMarketResolution> {
  if (existing.resolutionFinal) return existing;
  const full = await resolveOneMarket(hint);
  return full.marketFound ? full : existing;
}

async function resolveOneMarket(
  hint: MarketResolveHint
): Promise<GammaMarketResolution> {
  const conditionId = hint.conditionId.trim();
  if (!conditionId) {
    return classifyGammaMarketRow(null, "", "missing");
  }

  // A. conditionId lookup (single — batch multi-id only returns first match)
  const byCondition = await fetchGammaMarkets({ condition_ids: conditionId });
  const conditionMatch = pickMatchingRow(byCondition, conditionId);
  if (conditionMatch?.conditionId) {
    return classifyGammaMarketRow(conditionMatch, conditionId, "condition_id");
  }

  // B. slug fallback from activity/trade metadata
  for (const slug of hint.slugs) {
    if (!slug?.trim()) continue;
    const bySlug = await fetchGammaMarkets({ slug: slug.trim() });
    const slugMatch = pickMatchingRow(bySlug, conditionId);
    if (slugMatch?.conditionId || slugMatch?.slug) {
      return classifyGammaMarketRow(slugMatch, conditionId, "slug");
    }
  }

  // C. clob token / asset identifiers from events
  for (const asset of hint.assets) {
    if (!asset?.trim()) continue;
    const byToken = await fetchGammaMarkets({ clob_token_ids: asset.trim() });
    const tokenMatch = pickMatchingRow(byToken, conditionId);
    if (tokenMatch?.conditionId || tokenMatch?.slug) {
      return classifyGammaMarketRow(tokenMatch, conditionId, "clob_token");
    }
  }

  return classifyGammaMarketRow(null, conditionId, "missing");
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        results[current] = await fn(items[current], current);
        if (GAMMA_INTER_REQUEST_DELAY_MS > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, GAMMA_INTER_REQUEST_DELAY_MS)
          );
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}

export interface GammaPrefetchStats {
  hintsTotal: number;
  pending: number;
  cacheHits: number;
  conditionLookups: number;
  backfillLookups: number;
  skippedBackfill: number;
  resolvedBefore: number;
  resolvedAfter: number;
  marketsFoundBefore: number;
  marketsFoundAfter: number;
  elapsedMs: number;
}

export class GammaResolutionCache {
  private readonly cache = new Map<string, GammaMarketResolution>();
  private frozen = false;

  get(conditionId: string): GammaMarketResolution | undefined {
    return this.cache.get(normalizeConditionId(conditionId));
  }

  setFrozen(value: boolean): void {
    this.frozen = value;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  async resolve(
    conditionId: string,
    hint?: Partial<MarketResolveHint>
  ): Promise<GammaMarketResolution> {
    const key = normalizeConditionId(conditionId);
    if (!key) return classifyGammaMarketRow(null, "", "missing");
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.frozen) {
      return classifyGammaMarketRow(null, conditionId, "missing");
    }

    const resolution = await resolveOneMarket({
      conditionId,
      slugs: hint?.slugs ?? [],
      assets: hint?.assets ?? [],
    });
    this.cache.set(key, resolution);
    return resolution;
  }

  seed(conditionId: string, resolution: GammaMarketResolution): void {
    this.cache.set(normalizeConditionId(conditionId), resolution);
  }

  seedMany(entries: Iterable<[string, GammaMarketResolution]>): number {
    let seeded = 0;
    for (const [conditionId, resolution] of entries) {
      const key = normalizeConditionId(conditionId);
      if (!this.cache.has(key)) {
        this.cache.set(key, resolution);
        seeded += 1;
      }
    }
    return seeded;
  }

  exportEntries(): Array<[string, GammaMarketResolution]> {
    return [...this.cache.entries()];
  }

  async prefetch(
    hints: MarketResolveHint[]
  ): Promise<GammaPrefetchStats> {
    const started = Date.now();
    const hintsTotal = hints.length;
    const pending = hints.filter(
      (h) => h.conditionId.trim() && !this.cache.has(normalizeConditionId(h.conditionId))
    );
    const cacheHits = hintsTotal - pending.length;

    if (this.frozen || pending.length === 0) {
      return {
        hintsTotal,
        pending: this.frozen ? pending.length : 0,
        cacheHits,
        conditionLookups: 0,
        backfillLookups: 0,
        skippedBackfill: 0,
        resolvedBefore: this.countResolved(),
        resolvedAfter: this.countResolved(),
        marketsFoundBefore: this.countMarketFound(),
        marketsFoundAfter: this.countMarketFound(),
        elapsedMs: Date.now() - started,
      };
    }

    const conditionOnly = await mapWithConcurrency(
      pending,
      GAMMA_FETCH_CONCURRENCY,
      (hint) => resolveConditionIdOnly(hint)
    );
    for (let i = 0; i < pending.length; i += 1) {
      this.cache.set(
        normalizeConditionId(pending[i].conditionId),
        conditionOnly[i]
      );
    }
    const resolvedBefore = this.countResolved();
    const marketsFoundBefore = this.countMarketFound();

    const backfillTargets: Array<{ hint: MarketResolveHint; idx: number }> = [];
    let skippedBackfill = 0;
    for (let i = 0; i < pending.length; i += 1) {
      const existing = conditionOnly[i];
      const hint = pending[i];
      if (existing.resolutionFinal) {
        skippedBackfill += 1;
        continue;
      }
      if (
        !existing.marketFound &&
        hint.slugs.length === 0 &&
        hint.assets.length === 0
      ) {
        skippedBackfill += 1;
        continue;
      }
      backfillTargets.push({ hint, idx: i });
    }

    const backfilled = await mapWithConcurrency(
      backfillTargets,
      GAMMA_FETCH_CONCURRENCY,
      ({ hint, idx }) => backfillUnresolved(hint, conditionOnly[idx])
    );
    for (let i = 0; i < backfillTargets.length; i += 1) {
      const { idx } = backfillTargets[i];
      this.cache.set(
        normalizeConditionId(pending[idx].conditionId),
        backfilled[i]
      );
    }

    return {
      hintsTotal,
      pending: pending.length,
      cacheHits,
      conditionLookups: pending.length,
      backfillLookups: backfillTargets.length,
      skippedBackfill,
      resolvedBefore,
      resolvedAfter: this.countResolved(),
      marketsFoundBefore,
      marketsFoundAfter: this.countMarketFound(),
      elapsedMs: Date.now() - started,
    };
  }

  countResolved(): number {
    return [...this.cache.values()].filter((r) => r.resolutionFinal).length;
  }

  countMarketFound(): number {
    return [...this.cache.values()].filter((r) => r.marketFound).length;
  }
}

export function buildMarketResolveHints(
  events: Array<{
    conditionId?: string;
    asset?: string;
    slug?: string;
  }>
): MarketResolveHint[] {
  const map = new Map<
    string,
    { conditionId: string; slugs: Set<string>; assets: Set<string> }
  >();
  for (const event of events) {
    const conditionId = event.conditionId?.trim();
    if (!conditionId) continue;
    const key = normalizeConditionId(conditionId);
    if (!map.has(key)) {
      map.set(key, { conditionId, slugs: new Set(), assets: new Set() });
    }
    const entry = map.get(key)!;
    if (event.slug?.trim()) entry.slugs.add(event.slug.trim());
    if (event.asset?.trim()) entry.assets.add(event.asset.trim());
  }
  return [...map.values()].map((value) => ({
    conditionId: value.conditionId,
    slugs: [...value.slugs],
    assets: [...value.assets],
  }));
}

export function isWinningAsset(
  resolution: GammaMarketResolution,
  asset: string
): boolean | null {
  if (!resolution.resolutionFinal || !asset) return null;
  if (resolution.winningAsset) {
    return resolution.winningAsset === asset;
  }
  if (resolution.winningIndex != null && resolution.clobTokenIds.length > 0) {
    return resolution.clobTokenIds[resolution.winningIndex] === asset;
  }
  return null;
}
