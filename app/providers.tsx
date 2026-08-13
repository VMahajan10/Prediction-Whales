"use client";

import type { ReactNode } from "react";
import DemoAuthGate from "@/components/DemoAuthGate";
import FinancialDisclaimerGate from "@/components/FinancialDisclaimerGate";
import { PolymarketSocketProvider } from "@/lib/PolymarketSocketProvider";

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <DemoAuthGate>
      <FinancialDisclaimerGate>
        <PolymarketSocketProvider>{children}</PolymarketSocketProvider>
      </FinancialDisclaimerGate>
    </DemoAuthGate>
  );
}
