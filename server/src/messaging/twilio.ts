import { truncateError, type MessagingProvider, type SendResult } from "./provider";

/**
 * Tier 2 — Twilio (official WhatsApp Business API, or plain SMS).
 *
 * Implemented with a direct call to the REST API rather than the `twilio` npm package:
 * the SDK is a heavy dependency that a Tier 0 install would never load, and the whole
 * Messages endpoint is one form-encoded POST with Basic auth.
 *
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *   Authorization: Basic base64(AccountSid:AuthToken)
 *   Content-Type: application/x-www-form-urlencoded
 *   From=...&To=...&Body=...
 *
 * ⚠️ WhatsApp 24-hour window / approved templates
 * ------------------------------------------------
 * Free-form `Body` text is only delivered inside a 24-hour customer-service window that
 * the PARENT opens by messaging the business number first. Outside that window Meta only
 * permits *pre-approved template* messages, which Twilio sends with `ContentSid` +
 * `ContentVariables` instead of `Body` — so an absence alert at 6pm to a parent who has
 * never written to us will be rejected (error 63016) until the four Arabic templates in
 * `message_templates` have been submitted and approved. That approval process is why
 * Tier 2 takes days, and why Tier 1 (Green API) is the pragmatic middle ground for a
 * single tutor. With `channel: "SMS"` there is no window and no template approval at all.
 */

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** Sender: "+201001234567", or a Twilio WhatsApp sender such as "+14155238886". */
  from: string;
  channel: "WHATSAPP" | "SMS";
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const REQUEST_TIMEOUT_MS = 20_000;

type TwilioResponse = {
  sid?: string;
  message?: string;
  code?: number;
  status?: string;
};

export function twilioProvider(cfg: TwilioConfig): MessagingProvider {
  // WhatsApp addresses are the E.164 number prefixed with "whatsapp:"; SMS uses it bare.
  const wrap = (n: string) => (cfg.channel === "WHATSAPP" ? `whatsapp:${n}` : n);
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`;

  return {
    name: "TWILIO",
    autonomous: true,
    async send(toE164: string, body: string): Promise<SendResult> {
      const form = new URLSearchParams({
        From: wrap(cfg.from),
        To: wrap(toE164),
        Body: body,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: form.toString(),
          signal: controller.signal,
        });

        const text = await res.text();
        let data: TwilioResponse = {};
        try {
          data = JSON.parse(text) as TwilioResponse;
        } catch {
          data = {};
        }

        if (!res.ok) {
          const detail = data.message ?? text;
          const code = data.code ? ` [${data.code}]` : "";
          return {
            ok: false,
            error: truncateError(`${res.status}${code} ${detail}`),
            // 4xx = bad credentials, bad number, or outside the 24h window → no retry.
            retryable: res.status >= 500 || res.status === 429,
          };
        }

        return { ok: true, providerMessageId: data.sid };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, error: truncateError(message), retryable: true };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export default twilioProvider;
