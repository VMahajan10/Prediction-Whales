"use client";

import { useEffect, useState } from "react";
import type { OutcomeBooks } from "@/lib/crossMarketEv";
import { subscribeCrossMarketEvIndex } from "@/lib/crossMarketEvIndexClient";

export function useCrossMarketEvIndex() {
  const [index, setIndex] = useState<Map<string, OutcomeBooks>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => subscribeCrossMarketEvIndex((nextIndex, nextLoading) => {
    setIndex(nextIndex);
    setLoading(nextLoading);
  }), []);

  return { index, loading };
}
