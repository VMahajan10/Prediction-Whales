import type {
  ActivityApiRow,
  TradeApiRow,
  WalletLedgerEvent,
  WalletLedgerEventType,
} from "@/lib/walletLedger/types";

function roundKeyNumber(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return value.toFixed(6);
}

/**
 * Dedupe key for fills that may appear in both /activity and /trades.
 * Ambiguity: identical fills in the same tx with same size/price are rare but possible.
 */
export function buildLedgerEventDedupeKey(input: {
  txHash?: string;
  asset?: string;
  conditionId?: string;
  timestamp?: number;
  type: WalletLedgerEventType;
  side?: string;
  shares?: number;
  price?: number;
  cashUsd?: number;
}): string {
  const tx = (input.txHash ?? "").toLowerCase();
  const asset = input.asset ?? "";
  const conditionId = input.conditionId ?? "";
  return [
    tx || "notx",
    conditionId,
    asset,
    String(input.timestamp ?? 0),
    input.type,
    input.side ?? "",
    roundKeyNumber(input.shares),
    roundKeyNumber(input.price),
    roundKeyNumber(input.cashUsd),
  ].join("|");
}

function mapActivityType(type: string | undefined): WalletLedgerEventType | null {
  switch ((type ?? "").toUpperCase()) {
    case "TRADE":
      return null;
    case "REDEEM":
      return "REDEEM";
    case "MERGE":
      return "MERGE";
    case "SPLIT":
      return "SPLIT";
    default:
      return null;
  }
}

function normalizeActivityRow(
  row: ActivityApiRow,
  wallet: string
): WalletLedgerEvent[] {
  const conditionId = row.conditionId?.trim() ?? "";
  const asset = row.asset?.trim() ?? "";
  const timestamp = Number(row.timestamp ?? 0);
  const events: WalletLedgerEvent[] = [];

  const base = {
    wallet,
    conditionId,
    asset,
    timestamp,
    txHash: row.transactionHash,
    title: row.title,
    slug: row.slug,
    outcome: row.outcome,
    source: "activity" as const,
  };

  if ((row.type ?? "").toUpperCase() === "TRADE") {
    const side = (row.side ?? "").toUpperCase();
    if (side !== "BUY" && side !== "SELL") return events;
    const type: WalletLedgerEventType = side === "BUY" ? "BUY" : "SELL";
    const shares = Number(row.size ?? 0);
    const cashUsd = Number(row.usdcSize ?? 0);
    const price = Number(row.price ?? 0);
    const dedupeKey = buildLedgerEventDedupeKey({
      txHash: row.transactionHash,
      asset,
      conditionId,
      timestamp,
      type,
      side,
      shares,
      price,
      cashUsd,
    });
    events.push({
      ...base,
      type,
      shares,
      cashUsd,
      price,
      dedupeKey,
    });
    return events;
  }

  const mapped = mapActivityType(row.type);
  if (!mapped) return events;

  const shares = Number(row.size ?? 0);
  const cashUsd = Number(row.usdcSize ?? 0);
  const dedupeKey = buildLedgerEventDedupeKey({
    txHash: row.transactionHash,
    asset,
    conditionId,
    timestamp,
    type: mapped,
    shares,
    cashUsd,
  });

  events.push({
    ...base,
    type: mapped,
    shares,
    cashUsd,
    dedupeKey,
  });
  return events;
}

function normalizeTradeRow(row: TradeApiRow, wallet: string): WalletLedgerEvent | null {
  const side = row.side;
  if (side !== "BUY" && side !== "SELL") return null;
  const conditionId = row.conditionId?.trim() ?? "";
  const asset = row.asset?.trim() ?? "";
  const timestamp = Number(row.timestamp ?? 0);
  const shares = Number(row.size ?? 0);
  const price = Number(row.price ?? 0);
  const cashUsd = shares * price;
  const type: WalletLedgerEventType = side === "BUY" ? "BUY" : "SELL";

  return {
    wallet,
    conditionId,
    asset,
    timestamp,
    type,
    shares,
    cashUsd,
    price,
    txHash: row.transactionHash,
    source: "trades",
    title: row.title,
    slug: row.slug,
    outcome: row.outcome,
    dedupeKey: buildLedgerEventDedupeKey({
      txHash: row.transactionHash,
      asset,
      conditionId,
      timestamp,
      type,
      side,
      shares,
      price,
      cashUsd,
    }),
  };
}

export function normalizeActivityRows(
  rows: ActivityApiRow[],
  wallet: string
): WalletLedgerEvent[] {
  const events: WalletLedgerEvent[] = [];
  for (const row of rows) {
    events.push(...normalizeActivityRow(row, wallet));
  }
  return events;
}

export function normalizeTradeRows(
  rows: TradeApiRow[],
  wallet: string
): WalletLedgerEvent[] {
  const events: WalletLedgerEvent[] = [];
  for (const row of rows) {
    const event = normalizeTradeRow(row, wallet);
    if (event) events.push(event);
  }
  return events;
}

/**
 * Merge activity + trade events, preferring activity and dropping duplicate fills.
 */
export function deduplicateLedgerEvents(
  activityEvents: WalletLedgerEvent[],
  tradeEvents: WalletLedgerEvent[]
): WalletLedgerEvent[] {
  const byKey = new Map<string, WalletLedgerEvent>();

  for (const event of activityEvents) {
    byKey.set(event.dedupeKey, event);
  }

  for (const event of tradeEvents) {
    if (!byKey.has(event.dedupeKey)) {
      byKey.set(event.dedupeKey, event);
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.dedupeKey.localeCompare(b.dedupeKey);
  });
}

export function positionKey(event: Pick<WalletLedgerEvent, "conditionId" | "asset">): string {
  return `${event.conditionId}::${event.asset}`;
}
