import type { CapacitorConfig } from "@capacitor/cli";

const PRODUCTION_SERVER_URL = "https://marketpulse-sand-five.vercel.app";
const LOCAL_SERVER_URL =
  process.env.CAPACITOR_LOCAL_URL ?? "http://localhost:3000";

/**
 * Remote-shell pattern: the WebView loads a deployed Next.js URL so SSR and
 * /api/* routes stay on the server (not bundled locally).
 *
 * Toggle server target:
 * - Local dev:  CAPACITOR_SERVER_MODE=local npm run cap:sync
 * - Production: npm run cap:sync  (default)
 * - Override:   CAPACITOR_SERVER_URL=https://your-domain.vercel.app npm run cap:sync
 */
function resolveServerUrl(): string {
  const override = process.env.CAPACITOR_SERVER_URL?.trim();
  if (override) return override;

  const mode = process.env.CAPACITOR_SERVER_MODE?.trim().toLowerCase();
  if (mode === "local" || process.env.CAPACITOR_USE_LOCAL === "true") {
    return LOCAL_SERVER_URL;
  }

  return PRODUCTION_SERVER_URL;
}

const serverUrl = resolveServerUrl();

/**
 * `webDir` is a Capacitor sync placeholder when `server.url` is set.
 */
const config: CapacitorConfig = {
  appId: "com.predictionwhales.app",
  appName: "Prediction Whales",
  webDir: "www",
  server: {
    url: serverUrl,
    cleartext: serverUrl.startsWith("http://"),
    androidScheme: "https",
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: "#000000",
      androidScaleType: "CENTER_CROP",
    },
  },
};

export default config;
