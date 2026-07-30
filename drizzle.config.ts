import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Load env for local CLI runs (Render/production inject DATABASE_URL directly).
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

export default defineConfig({
  schema: "./lib/crossmarket/store/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
