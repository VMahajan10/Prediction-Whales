/**
 * Smoke-test The Odds API key against the /v4/sports endpoint.
 *
 * Usage:
 *   npx tsx scripts/test-odds-api.ts
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", override: false });
dotenv.config({ override: false });

const apiKey = process.env.ODDS_API_KEY?.trim();

async function main(): Promise<void> {
  if (!apiKey) {
    console.error("[test-odds-api] ODDS_API_KEY is not set");
    process.exit(1);
  }

  const url = `https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(apiKey)}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    console.error(
      "[test-odds-api] Request failed:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }

  if (response.status === 200) {
    const sports = (await response.json()) as unknown[];
    console.log(
      `[test-odds-api] 200 OK — sports endpoint reachable (${Array.isArray(sports) ? sports.length : 0} sports)`
    );
    process.exit(0);
  }

  const body = await response.text();
  console.error(
    `[test-odds-api] ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`
  );
  process.exit(1);
}

void main();
