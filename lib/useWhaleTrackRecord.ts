"use client";

import { useEffect, useRef, useState } from "react";
import type { CategoryStats, ClvStats, TrackRecord } from "@/lib/polymarket";
import { repairTrackRecord } from "@/lib/polymarket";
import type { CrossMarketEvStats } from "@/lib/crossMarketEvStats";
import {
  CLOSED_POSITIONS_API_LIMIT,
  type TraderClosedPosition,
  type TraderOpenPosition,
} from "@/lib/traderProfile";

export interface WhaleTrackRecordResponse {
  wallet: string | null;
  trackRecord: TrackRecord | null;
  openPositionCount: number;
  categoryStats?: CategoryStats[];
  clvStats?: ClvStats | null;
  crossMarketEvStats?: CrossMarketEvStats | null;
  closedPositions?: TraderClosedPosition[];
  openPositions?: TraderOpenPosition[];
  closedPositionsFetched?: number;
  closedPositionsApiLimit?: number;
  resolved: boolean;
  cached?: boolean;
  error?: string;
}

export function useWhaleTrackRecord(wallet: string | undefined) {
  const [data, setData] = useState<WhaleTrackRecordResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!wallet) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        const res = await fetch(
          `/api/whale-track-record?wallet=${encodeURIComponent(wallet)}`
        );
        if (id !== requestId.current) return;

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }

        const result: WhaleTrackRecordResponse = await res.json();
        if (id !== requestId.current) return;

        setData((prev) => {
          if (prev?.resolved && prev.trackRecord && !result.trackRecord) {
            return prev;
          }
          return result;
        });
      } catch (err) {
        if (id !== requestId.current) return;
        setError(
          err instanceof Error ? err.message : "Failed to load track record"
        );
      } finally {
        if (id === requestId.current) {
          setLoading(false);
        }
      }
    };

    void load();
  }, [wallet]);

  const trackRecord = data?.trackRecord
    ? repairTrackRecord(data.trackRecord)
    : null;

  return {
    data,
    trackRecord,
    loading,
    error,
    closedPositions: data?.closedPositions ?? [],
    openPositions: data?.openPositions ?? [],
    closedPositionsFetched:
      data?.closedPositionsFetched ?? data?.closedPositions?.length ?? 0,
    closedPositionsApiLimit:
      data?.closedPositionsApiLimit ?? CLOSED_POSITIONS_API_LIMIT,
  };
}
