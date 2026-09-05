/**
 * ربط حساب واتساب — the control plane of the teacher's own WhatsApp session.
 *
 * The teacher opens the linking screen, a QR appears, he scans it from his phone
 * (واتساب ← الأجهزة المرتبطة ← ربط جهاز) and from that moment `greenApiProvider`
 * delivers every parent notification **from his number**. That is the whole feature;
 * this file is the thin, typed client that makes it observable:
 *
 *   getState()       → is the account linked right now?
 *   getQr()          → the image to put on screen
 *   getLinkedPhone() → which number ended up sending
 *   logout()         → unlink it again
 *
 * Green API endpoints used (base https://api.green-api.com):
 *   GET  /waInstance{id}/getStateInstance/{token}
 *   GET  /waInstance{id}/qr/{token}
 *   GET  /waInstance{id}/getWaSettings/{token}
 *   POST /waInstance{id}/logout/{token}
 *
 * ⏱️ **The QR rotates.** WhatsApp regenerates the code roughly every 20 seconds and an
 * expired one simply will not scan, so `getQr()` is built to be *polled*: the linking
 * screen hits GET /api/whatsapp/qr about every 3 seconds and swaps the image each time,
 * exactly like web.whatsapp.com does. Nothing here is cached for that reason.
 *
 * Two rules hold in every function below:
 *
 *  1. **Nothing throws.** A dead network, a 500 from the gateway, a corrupt payload —
 *     all ordinary answers, returned as a typed result. Code that polls every three
 *     seconds must never be wrapped in a try/catch by its caller.
 *  2. **Every error is Arabic** and safe to show the teacher as-is, with the API token
 *     scrubbed out of it — the token lives in the request URL, and fetch quotes the URL
 *     in its own error messages.
 */
import { isValidE164, toE164 } from "../lib/phone";
import {
  greenApiUrl,
  redactToken,
  REQUEST_TIMEOUT_MS,
  type GreenApiConfig,
} from "./green-api";
import { truncateError } from "./provider";

// ────────────────────────────── The link state ──────────────────────────────

/**
 * Provider-agnostic link state, stored verbatim in `Setting.whatsappState`
 * (a String column, like every other status in schema.prisma).
 */
export const WHATSAPP_STATES = [
  "UNKNOWN",
  "NOT_AUTHORIZED",
  "QR_PENDING",
  "AUTHORIZED",
  "BLOCKED",
  "ERROR",
] as const;

export type WhatsappState = (typeof WHATSAPP_STATES)[number];

/** How each state reads in the UI and in the audit trail. */
export const WHATSAPP_STATE_AR: Record<WhatsappState, string> = {
  UNKNOWN: "غير معروفة",
  NOT_AUTHORIZED: "غير مرتبط",
  QR_PENDING: "بانتظار مسح رمز QR",
  AUTHORIZED: "مرتبط",
  BLOCKED: "محظور",
  ERROR: "تعذّر الاتصال",
};

export const whatsappStateAr = (state: string): string =>
  WHATSAPP_STATE_AR[state as WhatsappState] ?? state;

/** A stored/attacker-supplied string → a known state; anything else is UNKNOWN. */
export function toWhatsappState(raw: unknown): WhatsappState {
  const value = String(raw ?? "").trim().toUpperCase();
  return (WHATSAPP_STATES as readonly string[]).includes(value)
    ? (value as WhatsappState)
    : "UNKNOWN";
}

/**
 * Green API's `stateInstance` → ours.
 *
 * `sleepMode` deliberately maps to AUTHORIZED: the account *is* linked, the phone is
 * merely offline for the moment — showing a QR there would be wrong, the teacher just
 * needs to wake his phone. `starting` maps to QR_PENDING because the instance is
 * booting towards a QR.
 */
export function normaliseState(stateInstance: unknown): WhatsappState {
  switch (String(stateInstance ?? "").trim().toLowerCase()) {
    case "authorized":
    case "sleepmode":
      return "AUTHORIZED";
    case "notauthorized":
      return "NOT_AUTHORIZED";
    case "starting":
      return "QR_PENDING";
    case "blocked":
      return "BLOCKED";
    default:
      return "UNKNOWN";
  }
}

// ──────────────────────────────── Results ───────────────────────────────────

export type StateResult =
  | { ok: true; state: WhatsappState; /** Green API's own word, for diagnostics. */ raw: string }
  | { ok: false; state: "ERROR"; error: string };

export type QrResult =
  | { kind: "qr"; pngDataUri: string }
  | { kind: "already-linked" }
  | { kind: "error"; error: string };

export type LogoutResult = { ok: true } | { ok: false; error: string };

// ───────────────────────────── Arabic messages ──────────────────────────────

const ERR_TIMEOUT = "انتهت مهلة الاتصال بخدمة واتساب — تحقّق من الإنترنت وأعد المحاولة";
const ERR_NETWORK = "تعذّر الاتصال بخدمة واتساب — تحقّق من الإنترنت";
const ERR_CREDENTIALS = "بيانات ربط واتساب غير صحيحة — راجع رقم النسخة ورمز الوصول";
const ERR_INSTANCE_NOT_FOUND = "لا توجد نسخة واتساب بهذا الرقم — راجع رقم النسخة";
const ERR_RATE_LIMIT = "تم تجاوز عدد الطلبات المسموح — انتظر قليلاً ثم أعد المحاولة";
const ERR_SERVER = "خدمة واتساب لا تستجيب حالياً — أعد المحاولة بعد قليل";
const ERR_REQUEST = "رفضت خدمة واتساب الطلب";
const ERR_BAD_PAYLOAD = "رد غير مفهوم من خدمة واتساب";
const ERR_NO_QR = "تعذّر الحصول على رمز QR — أعد المحاولة بعد قليل";
const ERR_LOGOUT_REFUSED = "رفضت خدمة واتساب فصل الحساب — أعد المحاولة بعد قليل";

/** An HTTP failure, told in Arabic. The body is quoted (briefly) for diagnosis only. */
function httpMessage(status: number, body: string, cfg: GreenApiConfig): string {
  if (status === 401 || status === 403) return ERR_CREDENTIALS;
  if (status === 404) return ERR_INSTANCE_NOT_FOUND;
  // 466 is Green API's own "monthly/second quota exceeded".
  if (status === 429 || status === 466) return ERR_RATE_LIMIT;
  if (status >= 500) return ERR_SERVER;

  const detail = truncateError(redactToken(String(body ?? "").trim(), cfg), 120);
  return detail ? `${ERR_REQUEST} (${status}): ${detail}` : `${ERR_REQUEST} (${status})`;
}

// ─────────────────────────────── The transport ──────────────────────────────

type Fetched<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * One Green API call: 20-second abort, no throw, Arabic failure.
 *
 * `apiMethod` is the endpoint segment ("getStateInstance", "qr", …); the URL — token
 * included — is built by `greenApiUrl` and never leaves this function.
 */
async function call<T>(
  cfg: GreenApiConfig,
  method: "GET" | "POST",
  apiMethod: string,
): Promise<Fetched<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(greenApiUrl(cfg, apiMethod), {
      method,
      // Green API's POST endpoints expect a JSON body even when it carries nothing.
      ...(method === "POST"
        ? { headers: { "Content-Type": "application/json" }, body: "{}" }
        : {}),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) return { ok: false, error: httpMessage(res.status, text, cfg) };

    // A 2xx with an empty body carries nothing, but nothing is broken either.
    if (text.trim() === "") return { ok: true, data: {} as T };

    try {
      return { ok: true, data: JSON.parse(text) as T };
    } catch {
      return { ok: false, error: ERR_BAD_PAYLOAD };
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const aborted = e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
    // Console only, and scrubbed: fetch quotes the request URL — which carries the token.
    console.error(`[ربط واتساب] ${apiMethod}:`, redactToken(detail, cfg));
    return { ok: false, error: aborted ? ERR_TIMEOUT : ERR_NETWORK };
  } finally {
    clearTimeout(timer);
  }
}

// ──────────────────────────────── getState ──────────────────────────────────

/**
 * GET /waInstance{id}/getStateInstance/{token}
 *   → { stateInstance: "authorized" | "notAuthorized" | "blocked" | "starting" | "sleepMode" }
 */
export async function getState(cfg: GreenApiConfig): Promise<StateResult> {
  const res = await call<{ stateInstance?: unknown }>(cfg, "GET", "getStateInstance");
  if (!res.ok) return { ok: false, state: "ERROR", error: res.error };

  const raw = String(res.data?.stateInstance ?? "").trim();
  return { ok: true, state: normaliseState(raw), raw };
}

// ───────────────────────────────── getQr ────────────────────────────────────

/** Base64 without the `data:` prefix is what Green API returns for `type: "qrCode"`. */
const BASE64 = /^[A-Za-z0-9+/=]+$/;

/** "iVBORw0KGgo…" → "data:image/png;base64,iVBORw0KGgo…", or null when it is not an image. */
function toPngDataUri(message: unknown): string | null {
  const raw = String(message ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("data:")) return raw; // already a data URI — pass it through

  const base64 = raw.replace(/\s+/g, "");
  if (base64.length < 32 || !BASE64.test(base64)) return null;
  return `data:image/png;base64,${base64}`;
}

/**
 * GET /waInstance{id}/qr/{token}
 *   → { type: "qrCode" | "alreadyLogged" | "error", message: "<base64 png>" }
 *
 * Poll this roughly every 3 seconds while the linking screen is open: WhatsApp rotates
 * the code about every 20 seconds and an expired image will not scan.
 */
export async function getQr(cfg: GreenApiConfig): Promise<QrResult> {
  const res = await call<{ type?: unknown; message?: unknown }>(cfg, "GET", "qr");
  if (!res.ok) return { kind: "error", error: res.error };

  const type = String(res.data?.type ?? "").trim().toLowerCase();

  if (type === "qrcode") {
    const pngDataUri = toPngDataUri(res.data?.message);
    return pngDataUri ? { kind: "qr", pngDataUri } : { kind: "error", error: ERR_NO_QR };
  }

  if (type === "alreadylogged") return { kind: "already-linked" };

  // type === "error" (or anything unexpected): `message` is Green API's own English
  // explanation — worth showing after the Arabic sentence, never instead of it.
  const detail = truncateError(redactToken(String(res.data?.message ?? "").trim(), cfg), 120);
  return { kind: "error", error: detail ? `${ERR_NO_QR} (${detail})` : ERR_NO_QR };
}

// ───────────────────────────── getLinkedPhone ───────────────────────────────

/**
 * GET /waInstance{id}/getWaSettings/{token}  → { phone: "201001234567", stateInstance }
 *
 * Green API reports the number in international form **without** the "+", so the plus is
 * restored before `toE164` sees it — otherwise the default country code would be glued
 * on a second time ("201001234567" → "+20201001234567").
 *
 * Returns null on any failure: an unlinked account, a network error and a nonsense
 * payload are all simply "no number to record".
 */
export async function getLinkedPhone(cfg: GreenApiConfig): Promise<string | null> {
  const res = await call<{ phone?: unknown }>(cfg, "GET", "getWaSettings");
  if (!res.ok) return null;

  const raw = String(res.data?.phone ?? "").trim();
  if (!raw) return null;

  const phone = toE164(`+${raw.replace(/^\++/, "")}`);
  return isValidE164(phone) ? phone : null;
}

// ──────────────────────────────── logout ────────────────────────────────────

/**
 * POST /waInstance{id}/logout/{token} → { isLogout: true }
 *
 * Unlinks the phone from the instance — the same thing as tapping «تسجيل الخروج» on
 * واتساب ← الأجهزة المرتبطة. The caller clears the stored credentials either way.
 */
export async function logout(cfg: GreenApiConfig): Promise<LogoutResult> {
  const res = await call<{ isLogout?: unknown }>(cfg, "POST", "logout");
  if (!res.ok) return { ok: false, error: res.error };

  // Only an explicit `false` is a refusal; an empty 200 body means it is done.
  return res.data?.isLogout === false ? { ok: false, error: ERR_LOGOUT_REFUSED } : { ok: true };
}
