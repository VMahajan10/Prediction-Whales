"use client";

import type { ReactNode } from "react";
import DemoAuthGate from "@/components/DemoAuthGate";
import { PolymarketSocketProvider } from "@/lib/PolymarketSocketProvider";

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <DemoAuthGate>
      <PolymarketSocketProvider>{children}</PolymarketSocketProvider>
    </DemoAuthGate>
  );
}
