"use client";

import { setTourActive } from "@/lib/explorer";

export default function WelcomeBanner() {
  function startTour() {
    setTourActive(true);
    const el = document.getElementById("market-feed");
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="mb-6 rounded-xl border border-blue-500/40 bg-gradient-to-br from-slate-800 to-slate-900 p-6">
      <h2 className="mb-3 text-lg font-semibold text-white">
        🎓 Welcome to Explorer Mode
      </h2>
      <p className="mb-2 text-sm text-slate-300">
        You have $1,000 of practice money. No real money. No risk. Just
        learning.
      </p>
      <p className="mb-1 text-sm font-medium text-slate-200">
        How prediction markets work:
      </p>
      <ul className="mb-4 list-inside list-disc space-y-1 text-sm text-slate-400">
        <li>People bet on real-world events</li>
        <li>
          The % shows how likely the crowd thinks something will happen
        </li>
        <li>
          You win big on unlikely events, win small on likely events
        </li>
      </ul>
      <button
        type="button"
        onClick={startTour}
        className="rounded-lg bg-pulse-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600"
      >
        Start the Tour →
      </button>
    </div>
  );
}
