import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        pulse: {
          bg: "#000000",
          card: "#1A1A1A",
          surface: "#141414",
          border: "#2A2A2A",
          accent: "#FF4500",
          "accent-hover": "#E63E00",
          yes: "#00E676",
          no: "#FF4444",
          muted: "#888888",
          label: "#666666",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      borderRadius: {
        pulse: "10px",
      },
      boxShadow: {
        accent: "0 4px 24px rgba(255, 69, 0, 0.25)",
      },
      padding: {
        "safe-top": "env(safe-area-inset-top)",
        "safe-bottom": "env(safe-area-inset-bottom)",
      },
    },
  },
  plugins: [],
};

export default config;
