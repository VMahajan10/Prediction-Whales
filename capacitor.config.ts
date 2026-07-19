import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Remote-shell pattern: the WebView loads the live Vercel deployment so
 * Next.js SSR and /api/* routes stay on the server (not bundled locally).
 * `webDir` is a Capacitor sync placeholder only when `server.url` is set.
 */
const config: CapacitorConfig = {
  appId: "com.marketpulse.app",
  appName: "MarketPulse",
  webDir: "www",
  server: {
    url: "https://marketpulse-sand-five.vercel.app",
    cleartext: false,
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
