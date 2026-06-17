"use client";

import type { ReactNode } from "react";
import { PolymarketSocketProvider } from "@/lib/PolymarketSocketProvider";

export default function Providers({ children }: { children: ReactNode }) {
  return <PolymarketSocketProvider>{children}</PolymarketSocketProvider>;
}
