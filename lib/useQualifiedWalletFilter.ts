"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { WalletFeedQualificationInput } from "@/lib/feedQualification";
import type {
  ResolvedWhaleIdentity,
  WalletQualificationApiResponse,
} from "@/lib/whaleIdentityResolver";

export interface WalletQualification extends WalletFeedQualificationInput {
  qualified: boolean;
  hydrationState?: "pending" | "complete" | "failed";
  identity: ResolvedWhaleIdentity;
}

type WalletQualificationMap = ReadonlyMap<string, WalletQualification>;

const EMPTY_IDENTITY: ResolvedWhaleIdentity = {
  pseudonym: "Anonymous Observer",
  initials: "AO",
  winRate: null,
  resolvedBetsCount: null,
  avgEv: null,
  roi: null,
};

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

    let cancelled = false;

    const markWalletsFetched = (walletsToMark: string[]) => {
      for (const wallet of walletsToMark) {
        fetchedWallets.current.add(wallet);
      }
    };

    void fetch("/api/whales/wallet-qualification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallets: missing }),
    })
      .then((response) => response.json())
      .then((data: WalletQualificationApiResponse) => {
          if (cancelled) return;
          markWalletsFetched(missing);
          setQualifications((current) => {
            const next = new Map(current);
            for (const [wallet, result] of Object.entries(
              data.qualifications ?? {}
            )) {
              next.set(wallet.toLowerCase(), {
                qualified: result.qualified === true,
                hydrationState: result.hydrationState ?? "pending",
                avgEv: result.avgEv ?? null,
                resolvedBetsCount: result.resolvedBetsCount ?? null,
                avgStakeNotional: result.avgStakeNotional ?? null,
                resolvedVolumeUSD: result.resolvedVolumeUSD ?? null,
                identity: result.identity ?? EMPTY_IDENTITY,
              });
            }
            for (const wallet of missing) {
              if (!next.has(wallet)) {
                next.set(wallet, {
                  qualified: false,
                  hydrationState: "pending",
                  avgEv: null,
                  resolvedBetsCount: null,
                  avgStakeNotional: null,
                  resolvedVolumeUSD: null,
                  identity: EMPTY_IDENTITY,
                });
              }
            }
            return next;
          });
      })
      .catch(() => {
        if (cancelled) return;
        markWalletsFetched(missing);
        setQualifications((current) => {
          const next = new Map(current);
          for (const wallet of missing) {
            next.set(wallet, {
              qualified: false,
              avgEv: null,
              resolvedBetsCount: null,
              avgStakeNotional: null,
              resolvedVolumeUSD: null,
              identity: EMPTY_IDENTITY,
            });
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
