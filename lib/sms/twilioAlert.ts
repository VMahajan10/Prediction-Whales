/**
 * Twilio SMS alerts removed — trade notifications use Telegram + Resend email.
 * This module is retained only as a tombstone; do not re-enable without review.
 */

export interface TwilioSmsResult {
  sent: boolean;
  skipped?: boolean;
  error?: string;
  messageSid?: string;
}

export function isTwilioSmsConfigured(): boolean {
  return false;
}

export function getTwilioAlertSmsTo(): string | null {
  return null;
}

/** Disabled — use Telegram (`lib/notifications/telegram.ts`) instead. */
export async function sendTwilioSmsAlert(
  _body: string
): Promise<TwilioSmsResult> {
  return {
    sent: false,
    skipped: true,
    error: "Twilio SMS alerts are disabled",
  };
}
