"use client";

import { useCallback, useEffect, useRef } from "react";
import type { WhaleTrade } from "@/lib/whaleTrades";

const SOUND_KEY = "marketpulse_whale_sound";

export function getWhaleSoundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === "true";
  } catch {
    return false;
  }
}

export function setWhaleSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage errors
  }
}

function playWhaleChime() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    // Audio blocked or unavailable
  }
}

export function useWhaleAlerts(
  newWhale: WhaleTrade | null,
  onDismiss: () => void
) {
  const lastSoundAt = useRef(0);

  useEffect(() => {
    if (!newWhale) return;

    if (getWhaleSoundEnabled() && newWhale.usdNotional >= 5000) {
      const now = Date.now();
      if (now - lastSoundAt.current > 5000) {
        lastSoundAt.current = now;
        playWhaleChime();
      }
    }

    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [newWhale, onDismiss]);
}

export function useWhaleSoundToggle() {
  const toggle = useCallback(() => {
    const next = !getWhaleSoundEnabled();
    setWhaleSoundEnabled(next);
    return next;
  }, []);

  return { getWhaleSoundEnabled, toggle };
}
