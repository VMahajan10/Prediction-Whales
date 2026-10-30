import type { BacktestFill, TradeClvRecord, WalletFunnelRow } from "@/lib/backtest/types";

const MARKET_LEVEL_EXCLUSIONS = new Set([
  "unresolved_market",
  "disputed_market",
  "missing_condition",
  "missing_asset",
  "unresolved_at_window_end",
  "pre_close",
  "post_resolution_fill",
]);

export function buildWalletFunnel(
  hydratedWallets: string[],
  ledgerBuyRowsByWallet: Map<string, number>,
  extractableBuysByWallet: Map<string, number>,
  fills: BacktestFill[],
  records: TradeClvRecord[]
): WalletFunnelRow[] {
  const parsedByWallet = new Map<string, number>();
  for (const f of fills) {
    const w = f.walletAddress.toLowerCase();
    parsedByWallet.set(w, (parsedByWallet.get(w) ?? 0) + 1);
  }

  const afterMarketByWallet = new Map<string, number>();
  const validClvByWallet = new Map<string, number>();
  const exclusionCounts = new Map<string, Map<string, number>>();

  for (const r of records) {
    const w = r.walletAddress.toLowerCase();
    if (
      !r.exclusionReason ||
      !MARKET_LEVEL_EXCLUSIONS.has(r.exclusionReason)
    ) {
      afterMarketByWallet.set(w, (afterMarketByWallet.get(w) ?? 0) + 1);
    }
    if (r.isValidClv) {
      validClvByWallet.set(w, (validClvByWallet.get(w) ?? 0) + 1);
    }
    if (r.exclusionReason) {
      const perWallet = exclusionCounts.get(w) ?? new Map<string, number>();
      perWallet.set(
        r.exclusionReason,
        (perWallet.get(r.exclusionReason) ?? 0) + 1
      );
      exclusionCounts.set(w, perWallet);
    }
  }

  const allWallets = new Set([
    ...hydratedWallets.map((w) => w.toLowerCase()),
    ...ledgerBuyRowsByWallet.keys(),
    ...parsedByWallet.keys(),
  ]);

  const rows: WalletFunnelRow[] = [];
  for (const wallet of allWallets) {
    const exclusions = exclusionCounts.get(wallet);
    let topExclusionReason: string | null = null;
    let topCount = 0;
    if (exclusions) {
      for (const [reason, count] of exclusions) {
        if (count > topCount) {
          topCount = count;
          topExclusionReason = reason;
        }
      }
    }
    rows.push({
      walletAddress: wallet,
      ledgerBuyRowsInWindow: ledgerBuyRowsByWallet.get(wallet) ?? 0,
      ledgerBuyRowsExtractable: extractableBuysByWallet.get(wallet) ?? 0,
      parsedFills: parsedByWallet.get(wallet) ?? 0,
      afterMarketFilters: afterMarketByWallet.get(wallet) ?? 0,
      validClv: validClvByWallet.get(wallet) ?? 0,
      topExclusionReason,
    });
  }

  rows.sort((a, b) => b.ledgerBuyRowsInWindow - a.ledgerBuyRowsInWindow);
  return rows;
}
