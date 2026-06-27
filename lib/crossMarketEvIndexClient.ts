"use client";

import type { OutcomeBooks } from "@/lib/crossMarketEv";

const REFRESH_MS = 60_000;

type Listener = (index: Map<string, OutcomeBooks>, loading: boolean) => void;

let index = new Map<string, OutcomeBooks>();
let loading = true;
let listeners = new Set<Listener>();
let fetchPromise: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let subscriberCount = 0;

function notify(): void {
  listeners.forEach((listener) => {
    listener(index, loading);
  });
}

function parseEntries(
  entries: Array<OutcomeBooks & { id: string }>
): Map<string, OutcomeBooks> {
  const map = new Map<string, OutcomeBooks>();
  for (const entry of entries) {
    map.set(entry.id, {
      game: entry.game,
      outcome: entry.outcome,
      kalshi: entry.kalshi,
      polymarket: entry.polymarket,
      manifold: entry.manifold ?? null,
      sportsbook: entry.sportsbook ?? null,
      label: entry.label,
    });
  }
  return map;
}

async function fetchIndex(): Promise<void> {
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const res = await fetch("/api/cross-market-ev/index");
      if (!res.ok) return;
      const data: {
        entries?: Array<OutcomeBooks & { id: string }>;
      } = await res.json();
      index = parseEntries(data.entries ?? []);
    } catch {
      // Index is optional — EV badge simply won't render
    } finally {
      loading = false;
      notify();
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

export function subscribeCrossMarketEvIndex(listener: Listener): () => void {
  listeners.add(listener);
  subscriberCount += 1;

  if (subscriberCount === 1) {
    void fetchIndex();
    refreshTimer = setInterval(() => {
      void fetchIndex();
    }, REFRESH_MS);
  }

  listener(index, loading);

  return () => {
    listeners.delete(listener);
    subscriberCount -= 1;
    if (subscriberCount === 0 && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };
}
