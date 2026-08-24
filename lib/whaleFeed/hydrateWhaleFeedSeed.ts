/**
 * Recent-seed hydration must not wait on `/api/feed` — that route can take 50s+
 * on production while `/api/trades/recent` returns in <1s.
 */
export async function hydrateWhaleFeedSeed(input: {
  loadRecentSeed: () => Promise<void>;
  loadBackfill: () => Promise<void>;
  markSeedLoaded: () => void;
}): Promise<void> {
  try {
    await input.loadRecentSeed();
  } catch {
    // Recent seed is best-effort; the loading gate still advances.
  } finally {
    input.markSeedLoaded();
  }

  void input.loadBackfill();
}
