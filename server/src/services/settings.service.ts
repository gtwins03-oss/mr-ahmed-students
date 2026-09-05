/**
 * The single-row settings table (id is always 1).
 *
 * Every other module reads configuration through `getSettings()` — thresholds,
 * auto-send flags, quiet hours, the active messaging provider and its
 * credentials all live here so the teacher can change behaviour without a
 * redeploy.
 *
 * Three of the columns describe the teacher's **own** WhatsApp account rather
 * than a parent's: `tutorWhatsapp` (the sending number, E.164),
 * `whatsappState` (UNKNOWN … AUTHORIZED, see ../messaging/whatsapp-link) and
 * `whatsappLinkedAt` (when the QR was last confirmed). They are read by every
 * screen, written by /api/whatsapp through `saveWhatsappLink()`, and
 * `tutorWhatsapp` is also offered to templates as `{{teacher_whatsapp}}`.
 */
import type { Prisma, Setting } from "@prisma/client";
import type { Request } from "express";
import { z } from "zod";

import { prisma } from "../db";
import { arPercent } from "../lib/arabic";
import { toE164 } from "../lib/phone";
import { parseValue, zTime } from "../lib/validate";
import { arTime } from "../messaging/template";
import {
  WHATSAPP_STATES,
  whatsappStateAr,
  type WhatsappState,
} from "../messaging/whatsapp-link";
import { emitChange } from "../realtime";
import { logAudit } from "./audit.service";

/** Providers the app knows how to resolve (see server/src/messaging). */
export const PROVIDERS = ["WA_LINK", "GREEN_API", "TWILIO"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** How each provider is named in Arabic prose (settings screen + audit log). */
export const PROVIDER_AR: Record<string, string> = {
  WA_LINK: "رابط واتساب اليدوي",
  GREEN_API: "Green API",
  TWILIO: "Twilio",
};

const providerAr = (name: string): string => PROVIDER_AR[name] ?? name;

/** Settings as the API exposes them: `providerConfig` parsed into an object. */
export type SettingsDto = Omit<Setting, "providerConfig"> & {
  providerConfig: Record<string, unknown>;
};

// ────────────────────────────── Validation ─────────────────────────────

const providerConfigSchema = z.union([
  z.record(z.unknown()),
  z
    .string()
    .trim()
    .transform((raw, ctx): Record<string, unknown> => {
      if (raw === "") return {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        /* falls through to the issue below */
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "إعدادات المزوّد يجب أن تكون كائن JSON صالح",
      });
      return z.NEVER;
    }),
]);

export const settingsPatchSchema = z
  .object({
    tutorName: z.string().trim().min(1, "اسم المُدرِّس مطلوب").max(120),
    centerName: z.string().trim().max(120),
    defaultCountryCode: z
      .string()
      .trim()
      .regex(/^\+\d{1,4}$/, "مفتاح الدولة يجب أن يبدأ بعلامة + ثم أرقام، مثل +20"),
    lowGradeThreshold: z.coerce
      .number({ invalid_type_error: "حد الدرجة المنخفضة يجب أن يكون رقماً" })
      .int("حد الدرجة المنخفضة يجب أن يكون رقماً صحيحاً")
      .min(0, "حد الدرجة المنخفضة لا يقل عن ٠")
      .max(100, "حد الدرجة المنخفضة لا يزيد عن ١٠٠"),
    autoSendAbsence: z.boolean(),
    autoSendLate: z.boolean(),
    autoSendLowGrade: z.boolean(),
    quietHoursStart: zTime,
    quietHoursEnd: zTime,
    provider: z.enum(PROVIDERS, {
      errorMap: () => ({ message: "مزوّد الرسائل غير معروف" }),
    }),
    providerConfig: providerConfigSchema,
    /** The teacher's own sending number. "" clears it; anything else is normalised to E.164. */
    tutorWhatsapp: z.string().trim().max(30, "رقم واتساب المُدرِّس طويل جداً"),
    whatsappState: z.enum(WHATSAPP_STATES, {
      errorMap: () => ({ message: "حالة ربط واتساب غير معروفة" }),
    }),
  })
  .partial()
  .strip();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

// ──────────────────────────────── Reads ────────────────────────────────

/**
 * Returns the settings row, creating it with schema defaults the first time.
 *
 * Deliberately a read-then-create rather than an `upsert({update:{}})`: this is
 * called on every enqueue and by the 2-minute dispatcher, and an empty upsert
 * would still issue a write (bumping `updatedAt`) on every single call.
 */
export async function getSettings(): Promise<Setting> {
  const existing = await prisma.setting.findUnique({ where: { id: 1 } });
  if (existing) return existing;

  try {
    return await prisma.setting.create({ data: { id: 1 } });
  } catch (err) {
    // Lost the race with a concurrent request — read the row it created.
    const row = await prisma.setting.findUnique({ where: { id: 1 } });
    if (row) return row;
    throw err;
  }
}

/** `providerConfig` is stored as a JSON string; never trust it to be valid. */
export function parseProviderConfig(settings: Setting): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(settings.providerConfig || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* corrupt blob → behave as if unconfigured */
  }
  return {};
}

/**
 * The API shape: identical to the row, with `providerConfig` as an object —
 * which includes the three WhatsApp-link columns (`tutorWhatsapp`,
 * `whatsappState`, `whatsappLinkedAt`), so every screen can read the link state
 * from the settings it already fetches.
 *
 * ⚠️ This DTO is the *credential form's* source of truth: the settings screen
 * binds `providerConfig.apiTokenInstance` directly and posts it back on save, so
 * the blob is returned as stored. Anything that does **not** need to re-submit
 * the credentials — /api/whatsapp above all — must expose `configured: boolean`
 * or `redactProviderConfig()` instead of this object.
 */
export function toSettingsDto(settings: Setting): SettingsDto {
  return { ...settings, providerConfig: parseProviderConfig(settings) };
}

/** Keys inside `providerConfig` whose value is a secret, whichever provider owns them. */
const SECRET_CONFIG_KEY = /(token|secret|password|key|sid)/i;

const CONFIG_REDACTED = "«محجوب»";

/**
 * `providerConfig` with every credential replaced by «محجوب» — safe for an audit
 * snapshot, a log line or any response that is not the credential form itself.
 */
export function redactProviderConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    out[key] = SECRET_CONFIG_KEY.test(key) && value ? CONFIG_REDACTED : value;
  }
  return out;
}

// ─────────────────────── Describing a change in Arabic ─────────────────

/** Credentials must never be copied into the audit trail. */
const redact = (settings: Setting): Record<string, unknown> => ({
  ...settings,
  providerConfig: settings.providerConfig === "{}" ? "{}" : "«بيانات اعتماد محجوبة»",
});

const flagAr = (on: boolean, label: string): string => `${on ? "فعّل" : "أوقف"} ${label}`;

/**
 * A human sentence per field that genuinely moved — «غيّر عتبة الدرجات من ٦٠٪
 * إلى ٥٠٪», not «تم تحديث الإعدادات». Returns [] when nothing changed, which is
 * the signal not to write history at all.
 */
function describeSettingsChange(before: Setting, after: Setting): string[] {
  const parts: string[] = [];

  if (before.lowGradeThreshold !== after.lowGradeThreshold) {
    parts.push(
      `غيّر عتبة الدرجات من ${arPercent(before.lowGradeThreshold)} إلى ${arPercent(after.lowGradeThreshold)}`,
    );
  }
  if (before.tutorName !== after.tutorName) {
    parts.push(`غيّر اسم المُدرِّس من "${before.tutorName}" إلى "${after.tutorName}"`);
  }
  if (before.centerName !== after.centerName) {
    parts.push(
      after.centerName ? `غيّر اسم المركز إلى "${after.centerName}"` : "مسح اسم المركز",
    );
  }
  if (before.defaultCountryCode !== after.defaultCountryCode) {
    parts.push(
      `غيّر مفتاح الدولة من ${before.defaultCountryCode} إلى ${after.defaultCountryCode}`,
    );
  }
  if (before.autoSendAbsence !== after.autoSendAbsence) {
    parts.push(flagAr(after.autoSendAbsence, "الإرسال التلقائي لتنبيهات الغياب"));
  }
  if (before.autoSendLate !== after.autoSendLate) {
    parts.push(flagAr(after.autoSendLate, "الإرسال التلقائي لتنبيهات التأخير"));
  }
  if (before.autoSendLowGrade !== after.autoSendLowGrade) {
    parts.push(flagAr(after.autoSendLowGrade, "الإرسال التلقائي لتنبيهات الدرجات المنخفضة"));
  }
  if (before.quietHoursStart !== after.quietHoursStart) {
    parts.push(
      `غيّر بداية ساعات الهدوء من ${arTime(before.quietHoursStart)} إلى ${arTime(after.quietHoursStart)}`,
    );
  }
  if (before.quietHoursEnd !== after.quietHoursEnd) {
    parts.push(
      `غيّر نهاية ساعات الهدوء من ${arTime(before.quietHoursEnd)} إلى ${arTime(after.quietHoursEnd)}`,
    );
  }
  if (before.provider !== after.provider) {
    parts.push(
      `غيّر مزوّد الرسائل من ${providerAr(before.provider)} إلى ${providerAr(after.provider)}`,
    );
  }
  if (before.providerConfig !== after.providerConfig) {
    // Deliberately vague: the values themselves are API keys.
    parts.push(`حدّث بيانات الاتصال بمزوّد ${providerAr(after.provider)}`);
  }

  // ── the teacher's own WhatsApp account ──
  if (before.tutorWhatsapp !== after.tutorWhatsapp) {
    if (!before.tutorWhatsapp) {
      parts.push(`سجّل رقم واتساب المُدرِّس ${after.tutorWhatsapp}`);
    } else if (!after.tutorWhatsapp) {
      parts.push(`مسح رقم واتساب المُدرِّس ${before.tutorWhatsapp}`);
    } else {
      parts.push(
        `غيّر رقم واتساب المُدرِّس من ${before.tutorWhatsapp} إلى ${after.tutorWhatsapp}`,
      );
    }
  }
  if (before.whatsappState !== after.whatsappState) {
    parts.push(
      `تغيّرت حالة ربط واتساب من «${whatsappStateAr(before.whatsappState)}» إلى «${whatsappStateAr(after.whatsappState)}»`,
    );
  }
  // `whatsappLinkedAt` is a stamp that always moves with the state above — describing
  // it too would add a second sentence saying the same thing.

  return parts;
}

// ──────────────────────────────── Writes ───────────────────────────────

/**
 * Validates a partial patch and persists it. Unknown keys are dropped, so the
 * route can hand over `req.body` untouched.
 *
 * `req` is optional so a script or a test can call this without an HTTP
 * request; the audit line then records the system as the actor.
 */
export async function updateSettings(
  patch: unknown,
  req: Request | null = null,
): Promise<Setting> {
  const data = parseValue(settingsPatchSchema, patch);

  // Also makes sure the row exists before updating it.
  const before = await getSettings();

  const { providerConfig, tutorWhatsapp, ...rest } = data;

  const after = await prisma.setting.update({
    where: { id: 1 },
    data: {
      ...rest,
      ...(providerConfig === undefined
        ? {}
        : { providerConfig: JSON.stringify(providerConfig) }),
      // Normalised on write, exactly like a parent's number: the teacher types
      // "01001234567" and the database keeps "+201001234567". "" clears it.
      ...(tutorWhatsapp === undefined
        ? {}
        : {
            tutorWhatsapp: tutorWhatsapp
              ? toE164(tutorWhatsapp, rest.defaultCountryCode ?? before.defaultCountryCode)
              : "",
          }),
    },
  });

  const changes = describeSettingsChange(before, after);
  if (changes.length > 0) {
    await logAudit(req, {
      action: "SETTINGS",
      entity: "Setting",
      entityId: String(after.id),
      summary: changes.join("، "),
      before: redact(before),
      after: redact(after),
    });
    emitChange("Setting");
  }

  return after;
}

// ─────────────────────── The teacher's WhatsApp account ────────────────────

/** What the linking flow (routes/whatsapp.ts) is allowed to write. */
export type WhatsappLinkPatch = {
  provider?: ProviderName;
  /** Already-parsed object; stored as the JSON string `providerConfig` column. */
  providerConfig?: Record<string, unknown>;
  /** E.164 as discovered from the linked account, or "" to clear it. */
  tutorWhatsapp?: string;
  whatsappState?: WhatsappState;
  whatsappLinkedAt?: Date | null;
};

export type WhatsappLinkResult = {
  settings: Setting;
  /** Arabic sentences for whatever actually moved — empty when nothing was written. */
  changes: string[];
};

const sameInstant = (a: Date | null, b: Date | null): boolean =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * Persists the WhatsApp-link columns, writing **only what actually moved**.
 *
 * The no-op guard is the point: the linking screen polls GET /api/whatsapp/qr
 * every ~3 seconds, and a poll that finds nothing new must not spend a write,
 * bump `updatedAt`, or fan a change event out to the other logged-in device.
 *
 * Unlike `updateSettings()` this does **not** log the audit line itself — the
 * caller does, because only it knows whether this was «ربط حساب واتساب جديد»,
 * «فصل حساب واتساب» or a background refresh. It returns the Arabic description
 * of the diff so a caller with nothing better to say can use that.
 */
export async function saveWhatsappLink(patch: WhatsappLinkPatch): Promise<WhatsappLinkResult> {
  const before = await getSettings();
  const data: Prisma.SettingUpdateInput = {};

  if (patch.provider !== undefined && patch.provider !== before.provider) {
    data.provider = patch.provider;
  }
  if (patch.providerConfig !== undefined) {
    const json = JSON.stringify(patch.providerConfig);
    if (json !== before.providerConfig) data.providerConfig = json;
  }
  if (patch.tutorWhatsapp !== undefined && patch.tutorWhatsapp !== before.tutorWhatsapp) {
    data.tutorWhatsapp = patch.tutorWhatsapp;
  }
  if (patch.whatsappState !== undefined && patch.whatsappState !== before.whatsappState) {
    data.whatsappState = patch.whatsappState;
  }
  if (
    patch.whatsappLinkedAt !== undefined &&
    !sameInstant(before.whatsappLinkedAt, patch.whatsappLinkedAt)
  ) {
    data.whatsappLinkedAt = patch.whatsappLinkedAt;
  }

  if (Object.keys(data).length === 0) return { settings: before, changes: [] };

  const after = await prisma.setting.update({ where: { id: 1 }, data });
  return { settings: after, changes: describeSettingsChange(before, after) };
}
