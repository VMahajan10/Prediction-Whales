import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "react",
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // Only Next.js applies React's `react-server` condition, which is what
      // makes this marker package inert; under vitest it resolves to a module
      // that throws on import. Point it at the no-op build instead.
      "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
});
