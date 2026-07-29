/**
 * Twilio SMS smoke test — DISABLED.
 * Trade alerts now use Telegram + Resend email only.
 *
 * Usage (prints notice and exits):
 *   node scripts/test-twilio.js
 */

console.error(
  "[test-twilio] Twilio SMS alerts are disabled. Use Telegram (TELEGRAM_*) and Resend email (SMTP_* / EMAIL_FROM)."
);
process.exit(1);

/* Legacy Twilio test retained below for reference — not executed.

require("dotenv/config");
const twilio = require("twilio");
// ...

*/
