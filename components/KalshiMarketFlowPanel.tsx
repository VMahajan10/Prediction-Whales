"use client";

interface KalshiAnonymousTradePanelProps {
  /** Optional deep link to the Kalshi market (no trader attribution). */
  ctaHref?: string;
}

export default function KalshiAnonymousTradePanel({
  ctaHref,
}: KalshiAnonymousTradePanelProps) {
  return (
    <section className="mb-8 rounded-xl border border-teal-500/30 bg-teal-950/20 p-6">
      <h2 className="mb-2 text-lg font-semibold text-white">
        🔒 Anonymous Kalshi Trade
      </h2>
      <p className="text-sm leading-relaxed text-slate-300">
        Kalshi is CFTC-regulated and does not expose trader identity in its
        public API — no wallet, user id, or pseudonym links trades to a person.
        A per-trader track record or copy-bet signal is therefore not available.
        Market-level flow and liquidity above are anonymous aggregates for this
        contract only.
      </p>
      {ctaHref ? (
        <a
          href={ctaHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-block rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-teal-600"
        >
          View market on Kalshi →
        </a>
      ) : null}
    </section>
  );
}
