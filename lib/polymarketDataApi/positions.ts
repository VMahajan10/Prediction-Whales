import { dataApiGetJson } from "@/lib/polymarketDataApi/http";
import type {
  V2PositionRow,
  V2PositionStatus,
  V2PositionsResponse,
} from "@/lib/polymarketDataApi/types";

const PAGE_LIMIT = 500;

/** Thrown when CLOSED pagination exceeds `maxClosedPages` (incomplete sync). */
export class WalletClosedPageCapExceeded extends Error {
  readonly wallet: string;
  readonly maxClosedPages: number;

  constructor(wallet: string, maxClosedPages: number) {
    super(
      `Wallet ${wallet} has more than ${maxClosedPages} CLOSED position pages`
    );
    this.name = "WalletClosedPageCapExceeded";
    this.wallet = wallet;
    this.maxClosedPages = maxClosedPages;
  }
}

export type FetchStatusPageResult = {
  rows: V2PositionRow[];
  hitPageCap: boolean;
};

export async function fetchV2PositionsPage(
  wallet: string,
  options: {
    status?: V2PositionStatus;
    cursor?: string;
    start?: number;
    limit?: number;
  }
): Promise<V2PositionsResponse> {
  const query: Record<string, string | number | undefined> = {
    user: wallet.toLowerCase(),
    limit: options.limit ?? PAGE_LIMIT,
  };
  if (options.status) query.status = options.status;
  if (options.cursor) query.cursor = options.cursor;
  if (options.start != null) query.start = options.start;
  return dataApiGetJson<V2PositionsResponse>("/v2/positions", query);
}

export async function fetchAllV2PositionsForStatus(
  wallet: string,
  status: V2PositionStatus,
  start?: number,
  options?: { maxPages?: number }
): Promise<V2PositionRow[]> {
  const { rows } = await fetchAllV2PositionsForStatusWithMeta(
    wallet,
    status,
    start,
    options
  );
  return rows;
}

export async function fetchAllV2PositionsForStatusWithMeta(
  wallet: string,
  status: V2PositionStatus,
  start?: number,
  options?: { maxPages?: number }
): Promise<FetchStatusPageResult> {
  const rows: V2PositionRow[] = [];
  const maxPages = options?.maxPages ?? 2000;
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchV2PositionsPage(wallet, {
      status,
      cursor,
      start,
    });
    const batch = res.data ?? [];
    for (const row of batch) rows.push(row);
    const pag = res.pagination;
    if (!pag?.has_more || !pag.next_cursor) {
      return { rows, hitPageCap: false };
    }
    cursor = pag.next_cursor;
  }
  return { rows, hitPageCap: true };
}

export async function fetchAllV2Positions(
  wallet: string,
  options?: { start?: number; maxClosedPages?: number }
): Promise<V2PositionRow[]> {
  const statuses: V2PositionStatus[] = ["CLOSED", "OPEN", "REDEEMABLE"];
  const all: V2PositionRow[] = [];
  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i];
    const closedCap =
      status === "CLOSED" ? options?.maxClosedPages : undefined;
    const { rows, hitPageCap } = await fetchAllV2PositionsForStatusWithMeta(
      wallet,
      status,
      options?.start,
      closedCap != null ? { maxPages: closedCap } : undefined
    );
    if (hitPageCap && closedCap != null) {
      throw new WalletClosedPageCapExceeded(wallet, closedCap);
    }
    for (const row of rows) all.push(row);
    if (i < statuses.length - 1) {
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  return all;
}
