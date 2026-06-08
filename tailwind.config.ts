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
          bg: "#0a0e17",
          card: "#111827",
          border: "#1f2937",
          accent: "#3b82f6",
          yes: "#22c55e",
          muted: "#9ca3af",
        },
      },
    },
  },
  plugins: [],
};

export default config;
