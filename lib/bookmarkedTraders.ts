const STORAGE_KEY = "marketpulse:bookmarkedTraders:v1";
export const BOOKMARKS_CHANGED_EVENT = "marketpulse:bookmarks-changed";

export interface BookmarkedTrader {
  /** Lowercase proxy wallet address */
  wallet: string;
  /** Cached display label, e.g. 0x1234…5678 */
  label: string;
  bookmarkedAt: number;
  /** Latest Polymarket trade hash used to open this trader */
  lastSeenTxHash?: string;
  /** Whether whale-trade alerts are enabled for this trader */
  alertsEnabled?: boolean;
}

function readAll(): BookmarkedTrader[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as BookmarkedTrader[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(bookmarks: BookmarkedTrader[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
    window.dispatchEvent(new CustomEvent(BOOKMARKS_CHANGED_EVENT));
  } catch {
    // Quota or serialization failure — non-fatal.
  }
}

export function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

export function walletLabel(wallet: string): string {
  const w = normalizeWallet(wallet);
  if (w.length <= 12) return w;
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}

export function getBookmarkedTraders(): BookmarkedTrader[] {
  return readAll().sort((a, b) => b.bookmarkedAt - a.bookmarkedAt);
}

export function getBookmarkedWalletSet(): Set<string> {
  return new Set(readAll().map((b) => b.wallet));
}

export function isBookmarked(wallet: string): boolean {
  const normalized = normalizeWallet(wallet);
  return readAll().some((b) => b.wallet === normalized);
}

export function addBookmark(params: {
  wallet: string;
  txHash?: string;
  label?: string;
}): BookmarkedTrader {
  const wallet = normalizeWallet(params.wallet);
  const existing = readAll();
  const idx = existing.findIndex((b) => b.wallet === wallet);
  const entry: BookmarkedTrader = {
    wallet,
    label: params.label ?? walletLabel(wallet),
    bookmarkedAt: idx >= 0 ? existing[idx].bookmarkedAt : Date.now(),
    lastSeenTxHash: params.txHash ?? existing[idx]?.lastSeenTxHash,
  };

  const next =
    idx >= 0
      ? existing.map((b, i) => (i === idx ? { ...b, ...entry } : b))
      : [entry, ...existing];

  writeAll(next);
  return entry;
}

export function removeBookmark(wallet: string): void {
  const normalized = normalizeWallet(wallet);
  writeAll(readAll().filter((b) => b.wallet !== normalized));
}

export function toggleBookmark(params: {
  wallet: string;
  txHash?: string;
  label?: string;
}): boolean {
  const wallet = normalizeWallet(params.wallet);
  if (isBookmarked(wallet)) {
    removeBookmark(wallet);
    return false;
  }
  addBookmark(params);
  return true;
}
