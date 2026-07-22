"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  isNonEmptyPassword,
  isValidEmailFormat,
} from "@/lib/demoAuthGate";
import { useDemoAuth } from "@/lib/DemoAuthGateContext";

type AuthMode = "signup" | "login";

interface DemoAuthScreenProps {
  mode: AuthMode;
  onToggleMode: () => void;
}

function BrandLogo() {
  return (
    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-pulse-border bg-pulse-card">
      <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden>
        <circle cx="16" cy="16" r="14" fill="none" stroke="#FF4500" strokeWidth="1.5" />
        <path
          d="M8 18c2-4 6-6 8-6s6 2 8 6c-2 2-5 3-8 3s-6-1-8-3z"
          fill="#FF4500"
          opacity="0.9"
        />
        <circle cx="12" cy="14" r="1" fill="#fff" />
      </svg>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white" aria-hidden>
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

export default function DemoAuthScreen({
  mode,
  onToggleMode,
}: DemoAuthScreenProps) {
  const { enter } = useDemoAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState({ email: false, password: false });

  const emailHint =
    touched.email && email.trim() && !isValidEmailFormat(email)
      ? "Use a valid email format (demo only)"
      : null;
  const passwordHint =
    touched.password && !isNonEmptyPassword(password)
      ? "Password empty (demo only)"
      : null;

  const goToFeed = () => {
    enter();
    router.push("/");
    router.refresh();
  };

  const isSignup = mode === "signup";

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-pulse-bg px-6 py-10 lg:max-w-lg">
      <div className="mb-10 text-center">
        <BrandLogo />
        <p className="mt-4 text-sm font-medium tracking-wide text-white">
          Prediction Market
        </p>
      </div>

      <div className="flex-1">
        <h1 className="text-3xl font-bold tracking-tight text-white">
          {isSignup ? "Create your account" : "Welcome back"}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-pulse-muted">
          {isSignup
            ? "Land on our real-time whale feed in under a minute."
            : "Sign in to jump back into the live whale feed."}
        </p>

        <form
          className="mt-10 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            goToFeed();
          }}
        >
          <div>
            <input
              id="demo-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              placeholder="YOU@EMAIL.COM"
              className="pulse-input"
            />
            {emailHint && (
              <p className="mt-1.5 text-xs text-pulse-accent/80">{emailHint}</p>
            )}
          </div>

          <div className="relative">
            <input
              id="demo-password"
              type={showPassword ? "text" : "password"}
              autoComplete={isSignup ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, password: true }))}
              placeholder={isSignup ? "CREATE PASSWORD" : "PASSWORD"}
              className="pulse-input pr-14"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-pulse-label transition-colors hover:text-white"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current stroke-2">
                {showPassword ? (
                  <>
                    <path d="M3 3l18 18" />
                    <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                    <path d="M9.9 5.1A10.7 10.7 0 0 1 12 5c5 0 9.3 3 11 7.5a11.8 11.8 0 0 1-2.1 3.6M6.7 6.7C4.2 8.4 2.4 10.8 1 13.5 2.7 17.5 7 20.5 12 20.5c1.1 0 2.2-.1 3.2-.4" />
                  </>
                ) : (
                  <>
                    <path d="M1 12s4-7.5 11-7.5 11 7.5 11 7.5-4 7.5-11 7.5S1 12 1 12z" />
                    <circle cx="12" cy="12" r="3" />
                  </>
                )}
              </svg>
            </button>
            {passwordHint && (
              <p className="mt-1.5 text-xs text-pulse-accent/80">{passwordHint}</p>
            )}
          </div>

          <button type="submit" className="pulse-btn-primary mt-6 shadow-accent">
            Go to Whale Feed
          </button>
        </form>

        <div className="my-8 flex items-center gap-4">
          <div className="h-px flex-1 bg-pulse-border" />
          <span className="pulse-label text-pulse-label">Or</span>
          <div className="h-px flex-1 bg-pulse-border" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={goToFeed}
            className="flex aspect-square items-center justify-center rounded-pulse border border-pulse-border bg-pulse-card transition-colors hover:border-pulse-muted"
            aria-label="Continue with Google"
          >
            <GoogleIcon />
          </button>
          <button
            type="button"
            onClick={goToFeed}
            className="flex aspect-square items-center justify-center rounded-pulse border border-pulse-border bg-pulse-card transition-colors hover:border-pulse-muted"
            aria-label="Continue with Apple"
          >
            <AppleIcon />
          </button>
        </div>

        <div className="mt-10 text-center text-sm text-pulse-muted">
          {isSignup ? (
            <>
              Already have an account?{" "}
              <button
                type="button"
                onClick={onToggleMode}
                className="font-semibold text-pulse-accent hover:underline"
              >
                Login
              </button>
            </>
          ) : (
            <>
              New here?{" "}
              <button
                type="button"
                onClick={onToggleMode}
                className="font-semibold text-pulse-accent hover:underline"
              >
                Create your account
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
