"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type WalletQualificationMap = ReadonlyMap<string, boolean>;

export function useQualifiedWalletFilter(
  walletAddresses: string[]
): WalletQualificationMap {
  const [qualifications, setQualifications] = useState<WalletQualificationMap>(
    () => new Map()
  );
  const fetchedWallets = useRef<Set<string>>(new Set());

  const walletKey = useMemo(() => {
    const unique = Array.from(
      new Set(
        walletAddresses
          .map((wallet) => wallet.trim().toLowerCase())
          .filter((wallet) => wallet.length > 0)
      )
    );
    return unique.sort().join(",");
  }, [walletAddresses]);

  useEffect(() => {
    if (!walletKey) return;

    const wallets = walletKey.split(",");
    const missing = wallets.filter(
      (wallet) => !fetchedWallets.current.has(wallet)
    );
    if (missing.length === 0) return;

    for (const wallet of missing) {
      fetchedWallets.current.add(wallet);
    }

    let cancelled = false;

    void fetch("/api/whales/wallet-qualification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallets: missing }),
    })
      .then((response) => response.json())
      .then((data: { qualifications?: Record<string, { qualified?: boolean }> }) => {
        if (cancelled) return;
        setQualifications((current) => {
          const next = new Map(current);
          for (const [wallet, result] of Object.entries(
            data.qualifications ?? {}
          )) {
            next.set(wallet.toLowerCase(), result.qualified === true);
          }
          for (const wallet of missing) {
            if (!next.has(wallet)) {
              next.set(wallet, false);
            }
          }
          return next;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setQualifications((current) => {
          const next = new Map(current);
          for (const wallet of missing) {
            next.set(wallet, false);
          }
          return next;
        });
      });

    return () => {
      cancelled = true;
    };
  }, [walletKey]);

  return qualifications;
}
