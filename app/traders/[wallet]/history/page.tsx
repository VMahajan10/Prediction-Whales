"use client";

import Link from "next/link";
import MobileAppShell from "@/components/MobileAppShell";
import WhaleProfile from "@/components/WhaleProfile";

function isValidWallet(wallet: string): boolean {
  return /^0x[a-f0-9]{40}$/i.test(wallet);
}

export default function TraderHistoryPage({
  params,
}: {
  params: { wallet: string };
}) {
  const wallet = decodeURIComponent(params.wallet).toLowerCase();

  if (!isValidWallet(wallet)) {
    return (
      <MobileAppShell>
        <main className="px-4 py-8">
          <Link
            href="/following"
            className="mb-6 inline-block text-sm text-pulse-muted hover:text-white"
          >
            ← Watchlist
          </Link>
          <p className="text-pulse-no">Invalid wallet address.</p>
        </main>
      </MobileAppShell>
    );
  }

  return <WhaleProfile wallet={wallet} defaultTab="trades" />;
}
