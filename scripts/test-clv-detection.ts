/**
 * Standalone test for detectClosingLine — run with:
 *   npx tsx scripts/test-clv-detection.ts
 */
import { detectClosingLine, type PricePoint } from "../lib/clvPriceHistory";

function hourlySeries(
  startT: number,
  hours: number,
  priceFn: (h: number) => number
): PricePoint[] {
  const pts: PricePoint[] = [];
  for (let h = 0; h < hours; h++) {
    pts.push({ t: startT + h * 3600, p: priceFn(h) });
  }
  return pts;
}

function runCase(
  name: string,
  series: PricePoint[],
  settled: 0 | 1,
  avgPrice: number,
  expectValid: boolean,
  expectReason?: string
) {
  const r = detectClosingLine(series, settled, avgPrice);
  const pass =
    r.valid === expectValid && (expectReason ? r.reason === expectReason : true);
  console.log(`\n=== ${name} ===`);
  console.log(`  valid: ${r.valid} (expected ${expectValid})`);
  console.log(`  reason: ${r.reason ?? "—"}`);
  console.log(`  closingLine: ${r.closingLine?.toFixed(3) ?? "—"}`);
  console.log(`  freshnessHours: ${r.freshnessHours?.toFixed(1) ?? "—"}`);
  console.log(`  clv: ${r.clv != null ? (r.clv >= 0 ? "+" : "") + r.clv.toFixed(3) : "—"}`);
  console.log(`  => ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

const T = 1_000_000;

// (a) Clean sports: uncollapsed ~3h before commit, settled YES
const sports: PricePoint[] = [
  ...hourlySeries(T, 18, () => 0.73),
  { t: T + 18 * 3600, p: 0.745 },
  { t: T + 19 * 3600, p: 0.74 },
  { t: T + 20 * 3600, p: 0.52 },
  { t: T + 21 * 3600, p: 0.98 },
  { t: T + 22 * 3600, p: 0.995 },
  { t: T + 23 * 3600, p: 0.998 },
];

// (b) Slow political drift: last uncollapsed ~38h before commit
const political: PricePoint[] = [
  { t: T, p: 0.85 },
  { t: T + 3600, p: 0.84 },
  { t: T + 7200, p: 0.86 },
  { t: T + 10800, p: 0.85 },
  { t: T + 14400, p: 0.85 },
  { t: T + 144000, p: 0.92 },
  { t: T + 147600, p: 0.92 },
  { t: T + 151200, p: 0.98 },
  { t: T + 154800, p: 0.995 },
  { t: T + 158400, p: 0.999 },
];

// (c) Collapsed from open — settled NO, always near 0
const collapsedOpen: PricePoint[] = hourlySeries(T, 10, () => 0.02);

const results = [
  runCase("(a) clean sports market", sports, 1, 0.31, true),
  runCase(
    "(b) slow political drift (40h)",
    political,
    1,
    0.14,
    false,
    "stale_line"
  ),
  runCase(
    "(c) collapsed from open",
    collapsedOpen,
    0,
    0.05,
    false,
    "always_collapsed"
  ),
];

console.log(`\n${results.every(Boolean) ? "All 3 tests PASSED" : "SOME TESTS FAILED"}`);
process.exit(results.every(Boolean) ? 0 : 1);
