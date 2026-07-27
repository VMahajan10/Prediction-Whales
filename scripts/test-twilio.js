/**
 * Standalone Twilio SMS smoke test for whale alert formatting.
 *
 * Usage:
 *   node scripts/test-twilio.js
 *
 * Requires in .env / .env.local:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, ALERT_SMS_TO
 * ALERT_SMS_TO may be a single E.164 number or comma-separated list.
 */
require("dotenv/config");

const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { config: loadDotenv } = require("dotenv");
const twilio = require("twilio");

const DEFAULT_APP_URL = "https://mvp-2324.onrender.com";

function loadLocalEnvFiles() {
  const cwd = process.cwd();
  for (const file of [".env", ".env.local"]) {
    const path = join(cwd, file);
    if (existsSync(path)) {
      loadDotenv({ path, override: file === ".env.local" });
      console.log(`📁 Loaded env file: ${file}`);
    }
  }
}

function resolveReviewBaseUrl() {
  const candidates = [
    process.env.REVIEW_PUBLIC_BASE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.APP_URL,
    DEFAULT_APP_URL,
  ];

  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (trimmed && trimmed !== "undefined") {
      return trimmed.replace(/\/$/, "");
    }
  }

  return DEFAULT_APP_URL;
}

function parseAlertSmsRecipients(raw) {
  if (!raw?.trim()) return [];

  const seen = new Set();
  const recipients = [];

  for (const part of raw.split(/[,;]/)) {
    const number = part.trim();
    if (!number || seen.has(number)) continue;
    seen.add(number);
    recipients.push(number);
  }

  return recipients;
}

function buildSampleAlertBody() {
  const queueId = "test-twilio-queue-" + Date.now();
  const reviewUrl = `${resolveReviewBaseUrl()}/review/${encodeURIComponent(queueId)}`;

  return [
    "🚀 [Whale Alert — Twilio Test]",
    "Stake: $25,000",
    "Market: Fed cut rates in September",
    "EV: +4.2%",
    `Review: ${reviewUrl}`,
    "Side: YES | Whale: DeepWallet",
  ].join(" | ");
}

function logTwilioError(error) {
  console.error("❌ Twilio send failed:");
  console.error("  message:", error?.message ?? "(none)");
  console.error("  code:", error?.code ?? "(none)");
  console.error("  status:", error?.status ?? "(none)");
  if (error?.moreInfo) {
    console.error("  moreInfo:", error.moreInfo);
  }
  if (error?.details) {
    console.error("  details:", error.details);
  }
  console.error("  full error:", error);
}

async function sendToRecipient(client, from, to, body) {
  console.log(`\n📱 Sending test SMS to: ${to}`);
  console.log("   From:", from);
  console.log("   Body length:", body.length, "chars");
  console.log("   Body preview:", body.slice(0, 120) + (body.length > 120 ? "…" : ""));

  try {
    const message = await client.messages.create({
      body,
      from,
      to,
    });

    console.log("✅ SMS sent successfully");
    console.log("   SID:", message.sid);
    console.log("   status:", message.status);
    return { ok: true, sid: message.sid };
  } catch (error) {
    logTwilioError(error);
    return { ok: false, error };
  }
}

async function main() {
  console.log("=== Twilio SMS test ===\n");

  loadLocalEnvFiles();

  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_PHONE_NUMBER?.trim();
  const recipients = parseAlertSmsRecipients(process.env.ALERT_SMS_TO);

  console.log("Step 1: Validate Twilio env");
  console.log("  TWILIO_ACCOUNT_SID:", accountSid ? `${accountSid.slice(0, 6)}…` : "(missing)");
  console.log("  TWILIO_AUTH_TOKEN:", authToken ? "(set)" : "(missing)");
  console.log("  TWILIO_PHONE_NUMBER:", from || "(missing)");
  console.log("  ALERT_SMS_TO raw:", process.env.ALERT_SMS_TO?.trim() || "(missing)");

  if (!accountSid || !authToken || !from) {
    console.error("\n❌ Missing required Twilio credentials. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.");
    process.exit(1);
  }

  if (recipients.length === 0) {
    console.error("\n❌ No ALERT_SMS_TO recipients parsed. Use E.164 format, e.g. +17036404542 or +1...,+1...");
    process.exit(1);
  }

  console.log("\nStep 2: Parse alert recipients");
  console.log("  Target numbers:", recipients.join(", "));

  console.log("\nStep 3: Build sample whale alert body");
  const body = buildSampleAlertBody();
  console.log("  Full message:\n", body);

  console.log("\nStep 4: Initialize Twilio client");
  const client = twilio(accountSid, authToken);
  console.log("  Client ready");

  console.log("\nStep 5: Dispatch test messages");
  const results = [];

  for (const to of recipients) {
    const result = await sendToRecipient(client, from, to, body);
    results.push({ to, ...result });
  }

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log("\n=== Summary ===");
  console.log(`  Sent: ${succeeded.length}/${results.length}`);
  for (const r of succeeded) {
    console.log(`  ✅ ${r.to} → SID ${r.sid}`);
  }
  for (const r of failed) {
    console.log(`  ❌ ${r.to} → failed`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("\n❌ Unexpected test script error:");
  logTwilioError(error);
  process.exit(1);
});
