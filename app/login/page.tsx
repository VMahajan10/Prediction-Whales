"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { sanitizeRedirectPath } from "@/lib/authRedirect";
import { useDemoAuth } from "@/lib/DemoAuthGateContext";

function LoginPageInner() {
  const { entered, checking } = useDemoAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (checking || !entered) return;

    try {
      const redirectTo = sanitizeRedirectPath(searchParams.get("redirectTo"));
      router.replace(redirectTo);
    } catch (error) {
      console.error("[login] Post-auth redirect failed:", error);
      try {
        router.replace("/");
      } catch (fallbackError) {
        console.error("[login] Fallback redirect failed:", fallbackError);
      }
    }
  }, [entered, checking, router, searchParams]);

  return null;
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
