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
    if (!checking && entered) {
      router.replace(sanitizeRedirectPath(searchParams.get("redirectTo")));
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
