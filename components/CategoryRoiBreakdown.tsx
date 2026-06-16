import type { CategoryStats } from "@/lib/polymarket";

interface CategoryRoiBreakdownProps {
  categories: CategoryStats[];
}

function roiColor(roi: number): string {
  if (roi >= 5) return "#22c55e";
  if (roi >= 0) return "#f59e0b";
  return "#ef4444";
}

function roiTextClass(roi: number): string {
  if (roi >= 5) return "text-pulse-yes";
  if (roi >= 0) return "text-amber-400";
  return "text-red-400";
}

function verdict(roi: number): string {
  if (roi >= 10) return "their strength";
  if (roi >= 5) return "solid edge";
  if (roi >= 0) return "barely ahead";
  return "don't tail here";
}

function formatRoi(roi: number): string {
  const sign = roi >= 0 ? "+" : "";
  return `${sign}${roi.toFixed(1)}%`;
}

export default function CategoryRoiBreakdown({
  categories,
}: CategoryRoiBreakdownProps) {
  if (!categories.length) return null;

  const maxAbsRoi = Math.max(...categories.map((c) => Math.abs(c.roi)), 1);

  return (
    <div className="mt-6 rounded-xl border border-slate-700 bg-slate-900/50 p-5">
      <h3 className="mb-4 text-base font-semibold text-white">
        Where they actually win
      </h3>

      <div className="space-y-4">
        {categories.map((cat) => {
          const barWidth = Math.max(
            4,
            (Math.abs(cat.roi) / maxAbsRoi) * 100
          );
          const color = roiColor(cat.roi);

          return (
            <div
              key={cat.category}
              className="grid grid-cols-[minmax(0,7rem)_1fr_minmax(0,5.5rem)] items-center gap-3 sm:grid-cols-[minmax(0,8rem)_1fr_minmax(0,6rem)]"
            >
              <div>
                <p className="text-sm font-semibold text-white">
                  {cat.category}
                </p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <p className="text-xs text-slate-400">
                    {cat.bets} bet{cat.bets === 1 ? "" : "s"}
                  </p>
                  {cat.lowSample && (
                    <span className="rounded-full bg-slate-700/60 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-slate-400">
                      small sample
                    </span>
                  )}
                </div>
              </div>

              <div className="h-2 rounded-full bg-slate-700">
                <div
                  className="h-2 rounded-full transition-all"
                  style={{
                    width: `${barWidth}%`,
                    backgroundColor: color,
                  }}
                />
              </div>

              <div className="text-right">
                <p
                  className={`text-sm font-semibold tabular-nums ${roiTextClass(cat.roi)}`}
                >
                  {formatRoi(cat.roi)}
                </p>
                <p className="text-[11px] text-slate-500">{verdict(cat.roi)}</p>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        Categories are approximate. ROI reflects closed positions only; small
        samples may not indicate real edge.
      </p>
    </div>
  );
}
