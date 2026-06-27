"use client";

import { useCallback, useEffect, useState } from "react";
import {
  addBookmark,
  BOOKMARKS_CHANGED_EVENT,
  getBookmarkedTraders,
  isBookmarked as isBookmarkedWallet,
  normalizeWallet,
  removeBookmark,
  toggleBookmark,
  type BookmarkedTrader,
} from "@/lib/bookmarkedTraders";

export function useBookmarkedTraders() {
  const [bookmarks, setBookmarks] = useState<BookmarkedTrader[]>(() =>
    typeof window !== "undefined" ? getBookmarkedTraders() : []
  );

  const refresh = useCallback(() => {
    setBookmarks(getBookmarkedTraders());
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener(BOOKMARKS_CHANGED_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(BOOKMARKS_CHANGED_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [refresh]);

  const isBookmarked = useCallback(
    (wallet: string | undefined) =>
      wallet ? isBookmarkedWallet(normalizeWallet(wallet)) : false,
    [bookmarks]
  );

  const bookmark = useCallback(
    (params: { wallet: string; txHash?: string; label?: string }) => {
      addBookmark(params);
      refresh();
    },
    [refresh]
  );

  const unbookmark = useCallback(
    (wallet: string) => {
      removeBookmark(wallet);
      refresh();
    },
    [refresh]
  );

  const toggle = useCallback(
    (params: { wallet: string; txHash?: string; label?: string }) => {
      const next = toggleBookmark(params);
      refresh();
      return next;
    },
    [refresh]
  );

  return {
    bookmarks,
    bookmarkCount: bookmarks.length,
    isBookmarked,
    bookmark,
    unbookmark,
    toggle,
    refresh,
  };
}
