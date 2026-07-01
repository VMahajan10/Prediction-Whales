import type { CachedMapping } from "@/lib/evPipeline/redisCache";
import type {
  PipelineTradeEv,
  PipelineTradeEvInput,
} from "@/lib/evPipeline/types";
import {
  pipelineEvLookupKeyKalshi,
  pipelineEvLookupKeyPm,
} from "@/lib/evPipeline/types";
import { normalizePipelineTradeEv } from "@/lib/evPipeline/tradeEvRecord";

/** Canonical PM CLOB token id (lowercase decimal string). */
export function normalizePmTokenId(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^pm:/i, "").toLowerCase();
}

/** Canonical Kalshi ticker (uppercase). */
export function normalizeKalshiTicker(
  raw: string | null | undefined
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^kalshi:/i, "").toUpperCase();
}

/** Shared cross-venue identifier for a mapped PM↔Kalshi pair. */
export function pipelineMappingPairKey(
  polymarketTokenId: string,
  kalshiTicker: string
): string {
  return `pair:${normalizePmTokenId(polymarketTokenId)}:${normalizeKalshiTicker(kalshiTicker)}`;
}

/** All lookup keys that should resolve to the same EV payload. */
export function pipelineEvLookupAliases(record: {
  key?: string;
  tokenId?: string | null;
  kalshiTicker?: string | null;
}): string[] {
  const aliases = new Set<string>();
  const tokenId = normalizePmTokenId(record.tokenId);
  const kalshiTicker = normalizeKalshiTicker(record.kalshiTicker);

  if (record.key?.trim()) aliases.add(record.key.trim());
  if (tokenId) aliases.add(pipelineEvLookupKeyPm(tokenId));
  if (kalshiTicker) aliases.add(pipelineEvLookupKeyKalshi(kalshiTicker));
  if (tokenId && kalshiTicker) {
    aliases.add(pipelineMappingPairKey(tokenId, kalshiTicker));
  }

  return Array.from(aliases);
}

export function enrichPipelineTradeEvCrossIds(
  record: PipelineTradeEv,
  lookupKey?: string
): PipelineTradeEv {
  const key = lookupKey ?? record.key;
  const tokenId = normalizePmTokenId(record.tokenId);
  const kalshiTicker = normalizeKalshiTicker(record.kalshiTicker);
  const mappingPairKey =
    tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : record.mappingPairKey ?? null;

  return {
    ...record,
    key,
    tokenId,
    kalshiTicker,
    mappingPairKey,
  };
}

/** Register one EV payload under pm:, kalshi:, and pair: aliases. */
export function indexPipelineTradeEvAliases(
  target: Map<string, PipelineTradeEv>,
  record: PipelineTradeEv,
  lookupKey?: string
): void {
  const enriched = enrichPipelineTradeEvCrossIds(record, lookupKey ?? record.key);
  const normalized =
    normalizePipelineTradeEv(enriched, enriched.key) ?? enriched;

  for (const alias of pipelineEvLookupAliases(normalized)) {
    target.set(alias, { ...normalized, key: alias });
  }
}

export function expandPipelineEvByKey(
  byKey: Record<string, PipelineTradeEv>
): Record<string, PipelineTradeEv> {
  const expanded: Record<string, PipelineTradeEv> = { ...byKey };

  for (const [lookupKey, record] of Object.entries(byKey)) {
    const enriched = enrichPipelineTradeEvCrossIds(record, lookupKey);
    const normalized =
      normalizePipelineTradeEv(enriched, lookupKey) ?? enriched;

    for (const alias of pipelineEvLookupAliases(normalized)) {
      if (!expanded[alias]) {
        expanded[alias] = { ...normalized, key: alias };
      }
    }
  }

  return expanded;
}

export function enrichPipelineEvInputFromMapping(
  input: PipelineTradeEvInput,
  mapping: CachedMapping | null | undefined
): PipelineTradeEvInput {
  if (!mapping) return input;

  return {
    ...input,
    tokenId:
      normalizePmTokenId(input.tokenId) ??
      normalizePmTokenId(mapping.polymarketTokenId) ??
      undefined,
    kalshiTicker:
      normalizeKalshiTicker(input.kalshiTicker) ??
      normalizeKalshiTicker(mapping.kalshiTicker) ??
      undefined,
  };
}
