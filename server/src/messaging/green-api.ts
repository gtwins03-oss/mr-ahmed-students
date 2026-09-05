import { toChatId } from "../lib/phone";
import { truncateError, type MessagingProvider, type SendResult } from "./provider";

/**
 * Tier 1 — Green API: an unofficial gateway that drives the teacher's *own* WhatsApp
 * number. Setup: create an instance at green-api.com, link it to the teacher's phone by
 * scanning a QR — from inside this app, see ./whatsapp-link and /api/whatsapp — and the
 * `idInstance` + `apiTokenInstance` pair is stored in `settings.providerConfig`.
 *
 * Fully automatic, ~$0–14/month, medium ban risk — which is exactly why `drainOutbox()`
 * throttles sends and respects quiet hours.
 *
 * This file is the **data plane** (sending). The *control plane* of the same session —
 * link state, QR, linked number, logout — lives in ./whatsapp-link and shares the URL
 * builder, the timeout and the token redaction below.
 */

export type GreenApiConfig = {
  idInstance: string;
  apiTokenInstance: string;
  apiUrl?: string;
};

/** Green API's shared host. Busy instances are issued their own, e.g. https://7103.api.greenapi.com. */
export const GREEN_API_BASE_URL = "https://api.green-api.com";

/** Every call — a send, a state probe, a QR poll — gives up after this long. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** The instance host, without a trailing slash. */
export const greenApiBase = (cfg: GreenApiConfig): string =>
  (cfg.apiUrl?.trim() || GREEN_API_BASE_URL).replace(/\/+$/, "");

/**
 * `https://api.green-api.com/waInstance{id}/{method}/{token}` — the shape of every
 * Green API endpoint.
 *
 * The token travels **in the URL**, which is the whole reason `redactToken()` exists
 * below: a Green API URL must never reach an error message, a console line or the
 * audit trail.
 */
export const greenApiUrl = (cfg: GreenApiConfig, method: string): string =>
  `${greenApiBase(cfg)}/waInstance${cfg.idInstance}/${method}/${cfg.apiTokenInstance}`;

/** Blanks the API token wherever it appears in text headed for a human. */
export function redactToken(text: string, cfg: GreenApiConfig): string {
  const token = String(cfg?.apiTokenInstance ?? "");
  const s = String(text ?? "");
  // A very short "token" is almost certainly junk — splitting on it would mangle the text.
  return token.length >= 8 ? s.split(token).join("«محجوب»") : s;
}

/** green-api.com shows the instance id as a number; both shapes are accepted. */
const readText = (value: unknown): string =>
  typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : "";

/**
 * `settings.providerConfig` (already parsed) → a usable config, or `null` when either
 * credential is missing. Never throws: a half-filled form is an ordinary answer.
 */
export function parseGreenApiConfig(raw: unknown): GreenApiConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const cfg = raw as Record<string, unknown>;
  const idInstance = readText(cfg.idInstance);
  const apiTokenInstance = readText(cfg.apiTokenInstance);
  if (!idInstance || !apiTokenInstance) return null;

  const apiUrl = readText(cfg.apiUrl);
  return apiUrl ? { idInstance, apiTokenInstance, apiUrl } : { idInstance, apiTokenInstance };
}

/** True when both credentials are present — backs `configured` in GET /api/whatsapp/status. */
export const hasGreenApiCredentials = (raw: unknown): boolean => parseGreenApiConfig(raw) !== null;

// ─────────────────────────────── The provider ────────────────────────────────

export function greenApiProvider(cfg: GreenApiConfig): MessagingProvider {
  const sendUrl = greenApiUrl(cfg, "sendMessage");

  return {
    name: "GREEN_API",
    autonomous: true,
    async send(toE164: string, body: string): Promise<SendResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(sendUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: toChatId(toE164), message: body }),
          signal: controller.signal,
        });

        const text = await res.text();
        if (!res.ok) {
          // 4xx = bad number / bad credentials / instance not authorised → do not retry.
          // 5xx or 429 = transient → let the dispatcher try again on the next tick.
          return {
            ok: false,
            error: truncateError(redactToken(`${res.status} ${text}`, cfg)),
            retryable: res.status >= 500 || res.status === 429,
          };
        }

        let idMessage: string | undefined;
        try {
          idMessage = (JSON.parse(text) as { idMessage?: string }).idMessage;
        } catch {
          // A 2xx with an unexpected body still means WhatsApp accepted it.
          idMessage = undefined;
        }
        return { ok: true, providerMessageId: idMessage };
      } catch (e) {
        // Network blip, DNS failure or our own timeout — always worth one more attempt.
        // The message can quote the request URL, so it is redacted before it is stored.
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, error: truncateError(redactToken(message, cfg)), retryable: true };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export default greenApiProvider;
