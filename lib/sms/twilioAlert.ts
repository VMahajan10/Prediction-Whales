import twilio from "twilio";

export interface TwilioSmsResult {
  sent: boolean;
  skipped?: boolean;
  error?: string;
  messageSid?: string;
}

export function isTwilioSmsConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
      process.env.TWILIO_AUTH_TOKEN?.trim() &&
      process.env.TWILIO_PHONE_NUMBER?.trim() &&
      process.env.ALERT_SMS_TO?.trim()
  );
}

export function getTwilioAlertSmsTo(): string | null {
  const to = process.env.ALERT_SMS_TO?.trim();
  return to || null;
}

function createTwilioClient(): ReturnType<typeof twilio> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID!.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN!.trim();
  return twilio(accountSid, authToken);
}

/** Send a whale alert SMS via the official Twilio API. */
export async function sendTwilioSmsAlert(
  body: string
): Promise<TwilioSmsResult> {
  if (!isTwilioSmsConfigured()) {
    return {
      sent: false,
      skipped: true,
      error: "Twilio SMS env vars are not configured",
    };
  }

  const from = process.env.TWILIO_PHONE_NUMBER!.trim();
  const to = process.env.ALERT_SMS_TO!.trim();

  try {
    const message = await createTwilioClient().messages.create({
      body,
      from,
      to,
    });

    return { sent: true, messageSid: message.sid };
  } catch (error) {
    console.error("Twilio SMS send failed:", error);
    return {
      sent: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
