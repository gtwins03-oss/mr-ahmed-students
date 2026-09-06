/**
 * Provider resolution — the only place that turns a Settings row into a live adapter.
 *
 * The golden rule here is **never throw**. A half-filled credential form or a corrupt
 * `providerConfig` JSON blob must degrade to Tier 0 (wa.me links) so the teacher can
 * still work by hand, rather than take the whole outbox down.
 */
import { z } from "zod";
import type { Setting } from "@prisma/client";

import { isValidE164, toE164, toWaAppLink, toWaLink } from "../lib/phone";
import type { MessagingProvider, ProviderName } from "./provider";
import { waLinkProvider } from "./wa-link";
import { greenApiProvider } from "./green-api";
import { twilioProvider } from "./twilio";

export type { MessagingProvider, ProviderName, SendResult } from "./provider";
export { waLinkProvider } from "./wa-link";
export { greenApiProvider } from "./green-api";
export { twilioProvider } from "./twilio";

/** Anything with these two columns resolves — a full `Setting` row satisfies it. */
export type ProviderSettings = Pick<Setting, "provider" | "providerConfig">;

/** What `testProvider` needs on top of that. */
export type TestSettings = ProviderSettings &
  Partial<Pick<Setting, "defaultCountryCode" | "tutorName" | "centerName">>;

// ───────────────────────────── credential schemas ─────────────────────────────

const greenApiSchema = z.object({
  // green-api.com shows the instance id as a number; accept either shape.
  idInstance: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((s) => s.length > 0),
  apiTokenInstance: z.string().trim().min(1),
  apiUrl: z.string().trim().min(1).optional(),
});

const twilioSchema = z.object({
  accountSid: z.string().trim().min(1),
  authToken: z.string().trim().min(1),
  from: z.string().trim().min(1),
  channel: z.enum(["WHATSAPP", "SMS"]).default("WHATSAPP"),
});

/**
 * Parses the `providerConfig` JSON blob. Malformed or non-object → `{}`.
 * Accepts an already-parsed object too, because API responses expose
 * `providerConfig` parsed rather than as a string.
 */
export function parseProviderConfig(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object") {
    return Array.isArray(raw) ? {} : (raw as Record<string, unknown>);
  }
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ────────────────────────────── resolveProvider ───────────────────────────────

/**
 * Reads `settings.provider` + `settings.providerConfig` and returns the matching
 * adapter. Falls back to `waLinkProvider` whenever the provider is unknown, the JSON
 * is malformed, or a required credential is missing.
 */
export function resolveProvider(settings: ProviderSettings): MessagingProvider {
  const name = String(settings?.provider ?? "").trim().toUpperCase();
  const cfg = parseProviderConfig(settings?.providerConfig);

  if (name === "GREEN_API") {
    const parsed = greenApiSchema.safeParse(cfg);
    return parsed.success ? greenApiProvider(parsed.data) : waLinkProvider;
  }

  if (name === "TWILIO") {
    const parsed = twilioSchema.safeParse(cfg);
    return parsed.success ? twilioProvider(parsed.data) : waLinkProvider;
  }

  // WA_LINK, empty, or anything we do not recognise.
  return waLinkProvider;
}

/** True when the configured provider is missing credentials and silently fell back. */
export function isProviderConfigured(settings: ProviderSettings): boolean {
  const name = String(settings?.provider ?? "").trim().toUpperCase();
  if (name !== "GREEN_API" && name !== "TWILIO") return true; // Tier 0 needs nothing
  return resolveProvider(settings).name === name;
}

// ─────────────────────────────── testProvider ─────────────────────────────────

export type TestProviderResult = {
  ok: boolean;
  provider: ProviderName;
  autonomous: boolean;
  toPhone: string;
  body: string;
  /** Tier 0 only: the click-to-chat link the UI should open. */
  waLink?: string;
  /**
   * The same chat as `whatsapp://send?phone=…&text=…`. Ships beside `waLink`
   * for the same reason the outbox rows do: inside the APK an https link is
   * loaded by the WebView itself and never reaches the WhatsApp app, so
   * «اختبار الإرسال» → «فتح واتساب» would be a dead button without it.
   */
  waAppLink?: string;
  providerMessageId?: string;
  /** Raw provider error, for the Settings screen's diagnostics line. */
  error?: string;
  /** Arabic, safe to show to the teacher as-is. */
  message: string;
};

function testBody(settings: TestSettings): string {
  const who = String(settings?.tutorName ?? "").trim() || "الأستاذ أحمد";
  const center = String(settings?.centerName ?? "").trim();
  return [
    "رسالة تجريبية ✅",
    `هذه رسالة اختبار من نظام إدارة الطلاب والتنبيهات الخاص بـ ${who}${center ? ` — ${center}` : ""}.`,
    "إذا وصلتك هذه الرسالة فإن الإعدادات تعمل بشكل صحيح.",
  ].join("\n");
}

/**
 * Powers the «اختبار الإرسال» button in Settings: renders a short Arabic test message
 * and pushes it through the *currently configured* provider without touching the outbox.
 *
 * On Tier 0 there is nothing to send, so it returns the wa.me link for the UI to open.
 */
export async function testProvider(
  settings: TestSettings,
  toPhone: string,
): Promise<TestProviderResult> {
  const provider = resolveProvider(settings);
  const phone = toE164(toPhone, settings?.defaultCountryCode ?? "+20");
  const body = testBody(settings);

  const base = {
    provider: provider.name,
    autonomous: provider.autonomous,
    toPhone: phone,
    body,
  };

  if (!isValidE164(phone)) {
    return { ...base, ok: false, message: "رقم الهاتف غير صالح", error: "INVALID_PHONE" };
  }

  const requested = String(settings?.provider ?? "").trim().toUpperCase();
  if (requested !== provider.name && (requested === "GREEN_API" || requested === "TWILIO")) {
    return {
      ...base,
      ok: false,
      message: "بيانات الاعتماد ناقصة أو غير صحيحة — تم الرجوع إلى روابط واتساب",
      error: "MISSING_CREDENTIALS",
    };
  }

  if (!provider.autonomous) {
    return {
      ...base,
      ok: true,
      waLink: toWaLink(phone, body),
      waAppLink: toWaAppLink(phone, body),
      message: "المزوّد الحالي يدوي — اضغط لفتح واتساب وإرسال الرسالة التجريبية",
    };
  }

  const result = await provider.send(phone, body);
  if (result.ok) {
    return {
      ...base,
      ok: true,
      providerMessageId: result.providerMessageId,
      message: "تم إرسال الرسالة التجريبية بنجاح",
    };
  }

  return {
    ...base,
    ok: false,
    error: result.error,
    message: "فشل إرسال الرسالة التجريبية — راجع بيانات الاعتماد",
  };
}
