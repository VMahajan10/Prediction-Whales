"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import FinancialDisclaimerModal from "@/components/FinancialDisclaimerModal";
import {
  acceptFinancialDisclaimer,
  hasAcceptedFinancialDisclaimer,
  isLegalPublicPath,
} from "@/lib/legalCompliance";

export default function FinancialDisclaimerGate({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const exempt = isLegalPublicPath(pathname);

  useEffect(() => {
    setAccepted(hasAcceptedFinancialDisclaimer());
    setReady(true);
  }, []);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-pulse-bg">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-pulse-accent border-t-transparent"
          aria-hidden
        />
      </div>
    );
  }

  if (!accepted && !exempt) {
    return (
      <FinancialDisclaimerModal
        onAccept={() => {
          acceptFinancialDisclaimer();
          setAccepted(true);
        }}
      />
    );
  }

  return <>{children}</>;
}
