import { eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { xAgentTemplateVariants } from "@/lib/crossmarket/store/schema";
import {
  type CredibilityMode,
  type TemplateFamilyCopy,
  type TemplatePlaceholder,
  type TemplateVariantCopy,
  validateTemplateFamilyCopy,
} from "@/lib/templates/templateCopyData";
import { TEMPLATE_FAMILY_COPY_DEFAULTS } from "@/lib/templates/templateCopyDefaults";
import {
  TEMPLATE_FAMILIES,
  type TemplateFamily,
} from "@/lib/templates/templateTypes";

const CACHE_TTL_MS = 60_000;

export type TemplateCopySource = "db" | "bundled-defaults";

let cachedMap: Map<TemplateFamily, TemplateFamilyCopy> | null = null;
let cacheLoadedAt = 0;
let lastLoadSource: TemplateCopySource = "bundled-defaults";
let refreshPromise: Promise<TemplateCopySource> | null = null;

export function defaultsMap(): Map<TemplateFamily, TemplateFamilyCopy> {
  return new Map(
    TEMPLATE_FAMILY_COPY_DEFAULTS.map((def) => [def.family, def])
  );
}

function parseCredibility(raw: string | null): CredibilityMode | undefined {
  if (raw === "avg_ev" || raw === "win_rate" || raw === "any") return raw;
  return undefined;
}

function rowToVariant(row: {
  variantId: string;
  sentences: unknown;
  requiredPlaceholders: unknown;
  credibilityMode: string | null;
}): TemplateVariantCopy | null {
  if (!Array.isArray(row.sentences) || row.sentences.length === 0) {
    return null;
  }
  if (!Array.isArray(row.requiredPlaceholders)) return null;

  const sentences = row.sentences.map(String);
  const required = row.requiredPlaceholders.map(String) as TemplatePlaceholder[];

  return {
    id: row.variantId,
    sentences,
    required,
    credibility: parseCredibility(row.credibilityMode),
  };
}

export function buildTemplateCopyMap(
  families: TemplateFamilyCopy[]
): Map<TemplateFamily, TemplateFamilyCopy> | null {
  const map = new Map<TemplateFamily, TemplateFamilyCopy>();
  for (const family of TEMPLATE_FAMILIES) {
    const def = families.find((f) => f.family === family);
    if (!def || !validateTemplateFamilyCopy(def)) {
      return null;
    }
    map.set(family, def);
  }
  return map;
}

async function seedDefaultsIfEmpty(): Promise<void> {
  if (!isDatabaseEnabled()) return;
  const db = getDb();
  const rows = await db.select().from(xAgentTemplateVariants).limit(1);
  if (rows.length > 0) return;

  const now = new Date();
  for (const familyDef of TEMPLATE_FAMILY_COPY_DEFAULTS) {
    for (const variant of familyDef.variants) {
      await db.insert(xAgentTemplateVariants).values({
        family: familyDef.family,
        variantId: variant.id,
        sentences: variant.sentences,
        requiredPlaceholders: variant.required,
        credibilityMode: variant.credibility ?? null,
        isActive: true,
        updatedAt: now,
      });
    }
  }
}

async function loadTemplateCopyFromDatabase(
  readOnly: boolean
): Promise<Map<TemplateFamily, TemplateFamilyCopy> | null> {
  if (!isDatabaseEnabled()) return null;

  if (!readOnly) {
    await seedDefaultsIfEmpty();
  }

  const db = getDb();
  const tableRows = await db
    .select()
    .from(xAgentTemplateVariants)
    .where(eq(xAgentTemplateVariants.isActive, true));

  if (readOnly && tableRows.length === 0) {
    return null;
  }

  const byFamily = new Map<TemplateFamily, TemplateVariantCopy[]>();
  for (const row of tableRows) {
    const family = row.family as TemplateFamily;
    if (!TEMPLATE_FAMILIES.includes(family)) continue;
    const variant = rowToVariant(row);
    if (!variant) return null;
    const list = byFamily.get(family) ?? [];
    list.push(variant);
    byFamily.set(family, list);
  }

  const families: TemplateFamilyCopy[] = TEMPLATE_FAMILIES.map((family) => ({
    family,
    variants: byFamily.get(family) ?? [],
  }));

  return buildTemplateCopyMap(families);
}

export interface RefreshTemplateCopyOptions {
  /** When true, never seed empty DB (preview / audit). */
  readOnly?: boolean;
}

export async function refreshTemplateCopyCache(
  options: RefreshTemplateCopyOptions = {}
): Promise<TemplateCopySource> {
  const readOnly = options.readOnly === true;

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const fromDb = await loadTemplateCopyFromDatabase(readOnly);
      if (fromDb) {
        cachedMap = fromDb;
        cacheLoadedAt = Date.now();
        lastLoadSource = "db";
        return lastLoadSource;
      }
      cachedMap = defaultsMap();
      cacheLoadedAt = Date.now();
      lastLoadSource = "bundled-defaults";
      return lastLoadSource;
    } catch (error) {
      console.warn("[templateCopyLoader] DB load failed — using bundled defaults", {
        error: error instanceof Error ? error.message : error,
      });
      cachedMap = defaultsMap();
      cacheLoadedAt = Date.now();
      lastLoadSource = "bundled-defaults";
      return lastLoadSource;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export function getLastTemplateCopySource(): TemplateCopySource {
  return lastLoadSource;
}

export function getTemplateCopyMap(): Map<TemplateFamily, TemplateFamilyCopy> {
  if (cachedMap && Date.now() - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedMap;
  }
  return defaultsMap();
}

export function getTemplateFamilyCopy(
  family: TemplateFamily
): TemplateFamilyCopy {
  const map = getTemplateCopyMap();
  const def = map.get(family);
  if (!def || !validateTemplateFamilyCopy(def)) {
    const fallback = defaultsMap().get(family);
    if (!fallback) {
      throw new Error(`Missing template family ${family}`);
    }
    return fallback;
  }
  return def;
}

export function clearTemplateCopyCacheForTests(): void {
  cachedMap = null;
  cacheLoadedAt = 0;
  lastLoadSource = "bundled-defaults";
  refreshPromise = null;
}

export function setTemplateCopyCacheForTests(
  families: TemplateFamilyCopy[]
): void {
  const map = buildTemplateCopyMap(families);
  cachedMap = map ?? defaultsMap();
  cacheLoadedAt = Date.now();
  lastLoadSource = "bundled-defaults";
}

/** Read-only runtime audit — no seed, no cache mutation. */
export async function inspectRuntimeTemplateVariants(): Promise<{
  tableQueryable: boolean;
  rowCount: number;
  matchesBundledDefaults: boolean;
}> {
  if (!isDatabaseEnabled()) {
    return { tableQueryable: false, rowCount: 0, matchesBundledDefaults: false };
  }

  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(xAgentTemplateVariants)
      .where(eq(xAgentTemplateVariants.isActive, true));

    const bundled = defaultsMap();
    const matches = rowsMatchBundled(rows, bundled);
    return {
      tableQueryable: true,
      rowCount: rows.length,
      matchesBundledDefaults: matches,
    };
  } catch {
    return { tableQueryable: false, rowCount: 0, matchesBundledDefaults: false };
  }
}

function rowsMatchBundled(
  rows: Array<{
    family: string;
    variantId: string;
    sentences: unknown;
    requiredPlaceholders: unknown;
    credibilityMode: string | null;
  }>,
  bundled: Map<TemplateFamily, TemplateFamilyCopy>
): boolean {
  if (rows.length === 0) return false;

  const expectedCount = TEMPLATE_FAMILY_COPY_DEFAULTS.reduce(
    (n, f) => n + f.variants.length,
    0
  );
  if (rows.length !== expectedCount) return false;

  for (const row of rows) {
    const family = bundled.get(row.family as TemplateFamily);
    const variant = family?.variants.find((v) => v.id === row.variantId);
    if (!variant) return false;
    const sentences = JSON.stringify(row.sentences);
    const required = JSON.stringify(row.requiredPlaceholders);
    if (sentences !== JSON.stringify(variant.sentences)) return false;
    if (required !== JSON.stringify(variant.required)) return false;
    const cred = row.credibilityMode ?? null;
    const expectedCred = variant.credibility ?? null;
    if (cred !== expectedCred) return false;
  }
  return true;
}
