const STORAGE_KEY = "marketpulse:demo-entered";

export const DEMO_AUTH_CHANGED_EVENT = "marketpulse:demo-auth-changed";

function dispatchChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DEMO_AUTH_CHANGED_EVENT));
}

export function isAppReviewBypassActive(): boolean {
  if (process.env.NEXT_PUBLIC_APP_REVIEW_MODE === "true") return true;

  if (typeof window === "undefined") return false;

  const token = process.env.NEXT_PUBLIC_APP_REVIEW_BYPASS_TOKEN;
  if (!token) return false;
  return new URLSearchParams(window.location.search).get("review") === token;
}

export function hasDemoEntered(): boolean {
  if (isAppReviewBypassActive()) return true;

  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setDemoEntered(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, "true");
    dispatchChanged();
  } catch {
    // Non-fatal for demo gate.
  }
}

export function clearDemoEntered(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    dispatchChanged();
  } catch {
    // Non-fatal for demo gate.
  }
}

/** Cosmetic validation — never blocks demo entry. */
export function isValidEmailFormat(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function isNonEmptyPassword(password: string): boolean {
  return password.length > 0;
}
