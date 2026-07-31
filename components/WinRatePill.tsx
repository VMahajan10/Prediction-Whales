import { formatWhaleWinRatePercent } from "@/lib/whaleIdentityResolver";

interface WinRatePillProps {
  winRate: number | null | undefined;
  className?: string;
}

export default function WinRatePill({ winRate, className = "" }: WinRatePillProps) {
  const label = formatWhaleWinRatePercent(winRate);
  const muted = label === "—";

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
        muted
          ? "border-pulse-border text-pulse-muted"
          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
      } ${className}`}
      title="Wallet win rate on resolved bets"
    >
      {muted ? "WR —" : `${label} WR`}
    </span>
  );
}
