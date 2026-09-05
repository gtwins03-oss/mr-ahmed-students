/**
 * The outbox — the single choke point for every parent notification.
 *
 * `enqueueMessage()` is the ONLY function in the codebase that creates a message row.
 * Attendance, grades and reports all funnel through it, which is what keeps "mark a
 * student absent" and "notify the parent" in one testable place. `drainOutbox()` is the
 * other half: on Tier 1/2 it delivers the queue; on Tier 0 it is a deliberate no-op and
 * the teacher's thumb drains the queue from the Send Queue screen.
 */
import type { Message, Setting, Student } from "@prisma/client";

import { prisma } from "../db";
import { getSettings } from "../services/settings.service";
import { isValidE164, toE164 } from "../lib/phone";
import { arDate, arMonth, arTime, render } from "./template";
import { resolveProvider } from "./index";
import { truncateError } from "./provider";

export type TemplateKey = "ABSENCE" | "LATE" | "LOW_GRADE" | "MONTHLY_REPORT" | "CUSTOM";
export type RelatedType = "ATTENDANCE" | "GRADE" | "REPORT";
export type Channel = "WHATSAPP" | "SMS";

export type EnqueueInput = {
  studentId: string;
  templateKey: TemplateKey;
  vars: Record<string, unknown>;
  relatedType: RelatedType;
  relatedId: string;
  /** Idempotency key — the same real-world event never messages twice. */
  dedupeKey: string;
  channel?: Channel;
};

/** Spacing between sends: a burst of 30 identical messages looks like spam. */
export const THROTTLE_MS = 1500;
/** Give up after this many attempts; the message lands in FAILED for manual retry. */
export const MAX_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Local calendar date, "2026-09-05" — never a UTC timestamp. */
function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Variables every template may use, whatever triggered it. Caller vars are merged on
 * top, so a trigger can override `date_ar` or supply `subject` without ceremony.
 */
function baseVars(settings: Setting, student: Student): Record<string, unknown> {
  return {
    student_name: student.name,
    parent_name: student.parentName,
    teacher_name: settings.tutorName,
    // The sending number itself, so a template can say «للرد: {{teacher_whatsapp}}».
    // Empty until a WhatsApp account is linked (see routes/whatsapp.ts) — an unknown
    // or empty placeholder renders as "", never as the literal {{teacher_whatsapp}}.
    teacher_whatsapp: settings.tutorWhatsapp ?? "",
    threshold: settings.lowGradeThreshold,
    center_name: settings.centerName ?? "",
  };
}

// ───────────────────────────────── enqueue ─────────────────────────────────

/**
 * The outcome of an enqueue.
 *
 * `created` is the whole point of this type: the callers report a «تم إضافة {n}
 * رسالة إلى قائمة الإرسال» count to the teacher, and a `dedupeKey` hit adds
 * nothing. Without the flag, re-saving an unchanged attendance grid would claim
 * a message was queued every single time — which is exactly the double-messaging
 * the dedupeKey exists to rule out, told back to the teacher as if it happened.
 */
export type EnqueueResult = {
  message: Message;
  /** False when `dedupeKey` already had a row — nothing was added. */
  created: boolean;
};

/**
 * Renders a template and queues it as PENDING.
 *
 * Returns `null` — silently, this is not an error — when the student is inactive, the
 * template is missing or switched off, or the stored phone number cannot be normalised
 * to E.164. A bad phone number must never abort saving an attendance grid.
 */
export async function enqueueMessage(input: EnqueueInput): Promise<EnqueueResult | null> {
  const [settings, student, template] = await Promise.all([
    getSettings(),
    prisma.student.findUnique({ where: { id: input.studentId } }),
    prisma.messageTemplate.findUnique({ where: { key: input.templateKey } }),
  ]);

  if (!student || !student.isActive) return null;
  if (!template || !template.isActive) return null;

  const toPhone = toE164(student.parentPhone, settings.defaultCountryCode);
  if (!isValidE164(toPhone)) return null;

  // The unique dedupeKey does the work: a second enqueue for the same real-world
  // event must add nothing and rewrite nothing. Checking first (rather than
  // upserting with an empty `update`) is what lets us tell the caller whether a
  // message was actually added — an empty upsert cannot report that, and it also
  // spends a pointless write on every re-save of an unchanged grid.
  const existing = await prisma.message.findUnique({
    where: { dedupeKey: input.dedupeKey },
  });
  if (existing) return { message: existing, created: false };

  const body = render(template.body, {
    ...baseVars(settings, student),
    ...input.vars,
  });

  try {
    const message = await prisma.message.create({
      data: {
        studentId: student.id,
        toPhone,
        channel: input.channel ?? "WHATSAPP",
        templateKey: input.templateKey,
        body,
        status: "PENDING",
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        dedupeKey: input.dedupeKey,
      },
    });
    return { message, created: true };
  } catch (e) {
    // Two concurrent saves of the same grid can race past the check above and
    // collide on the unique index. The other request won — its row is the queued
    // message, and this call added nothing.
    if ((e as { code?: string }).code === "P2002") {
      const raced = await prisma.message.findUnique({
        where: { dedupeKey: input.dedupeKey },
      });
      return raced ? { message: raced, created: false } : null;
    }
    throw e;
  }
}

// ──────────────────────────────── dispatch ─────────────────────────────────

export type DrainResult = {
  processed: number;
  sent: number;
  failed: number;
  /** Set when nothing was attempted, with the reason. */
  skipped?: "manual-provider" | "quiet-hours" | "empty";
};

/**
 * Delivers up to `limit` PENDING messages. Wired to the every-two-minutes cron job.
 * A single failing message can never abort the batch: each send is wrapped in its own
 * try/catch, so one dead number does not strand the other nineteen parents.
 */
export async function drainOutbox(limit = 20): Promise<DrainResult> {
  const settings = await getSettings();
  const provider = resolveProvider(settings);

  const idle: DrainResult = { processed: 0, sent: 0, failed: 0 };

  // Tier 0: the teacher sends by hand from the Send Queue screen.
  if (!provider.autonomous) return { ...idle, skipped: "manual-provider" };
  if (inQuietHours(settings)) return { ...idle, skipped: "quiet-hours" };

  const batch = await prisma.message.findMany({
    where: { status: "PENDING", attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(limit, 100)),
  });

  if (batch.length === 0) return { ...idle, skipped: "empty" };

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < batch.length; i++) {
    const m = batch[i];

    try {
      if (!isValidE164(m.toPhone)) {
        failed++;
        await prisma.message.update({
          where: { id: m.id },
          data: {
            status: "FAILED",
            provider: provider.name,
            error: "رقم الهاتف غير صالح",
            attempts: { increment: 1 },
          },
        });
        continue; // nothing was sent — no need to throttle
      }

      const result = await provider.send(m.toPhone, m.body);

      if (result.ok) {
        sent++;
        await prisma.message.update({
          where: { id: m.id },
          data: {
            status: "SENT",
            sentAt: new Date(),
            provider: provider.name,
            providerMsgId: result.providerMessageId ?? null,
            attempts: { increment: 1 },
            error: null,
          },
        });
      } else {
        failed++;
        const keepTrying = result.retryable && m.attempts < MAX_ATTEMPTS - 1;
        await prisma.message.update({
          where: { id: m.id },
          data: {
            status: keepTrying ? "PENDING" : "FAILED",
            provider: provider.name,
            error: truncateError(result.error),
            attempts: { increment: 1 },
          },
        });
      }
    } catch (e) {
      // A provider that throws, or a lost DB row, must not stop the queue.
      failed++;
      const message = e instanceof Error ? e.message : String(e);
      console.error("[outbox] تعذّر إرسال الرسالة", m.id, message);
      try {
        await prisma.message.update({
          where: { id: m.id },
          data: { error: truncateError(message), attempts: { increment: 1 } },
        });
      } catch {
        /* row vanished mid-drain — nothing sensible left to do */
      }
    }

    if (i < batch.length - 1) await sleep(THROTTLE_MS);
  }

  return { processed: batch.length, sent, failed };
}

/**
 * Sends one queued message immediately through the active provider.
 * Backs `POST /api/messages/:id/send` (Tier 1/2 «إرسال الآن» and the retry button).
 */
export async function sendMessageNow(messageId: string): Promise<{ ok: boolean; error?: string }> {
  const [settings, message] = await Promise.all([
    getSettings(),
    prisma.message.findUnique({ where: { id: messageId } }),
  ]);

  if (!message) return { ok: false, error: "الرسالة غير موجودة" };
  if (message.status === "SENT") return { ok: true };

  const provider = resolveProvider(settings);
  if (!provider.autonomous) {
    return { ok: false, error: "المزوّد الحالي يدوي — استخدم زر «فتح واتساب» ثم «تم الإرسال»" };
  }
  if (!isValidE164(message.toPhone)) {
    await prisma.message.update({
      where: { id: message.id },
      data: { status: "FAILED", error: "رقم الهاتف غير صالح", attempts: { increment: 1 } },
    });
    return { ok: false, error: "رقم الهاتف غير صالح" };
  }

  try {
    const result = await provider.send(message.toPhone, message.body);

    if (result.ok) {
      await prisma.message.update({
        where: { id: message.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          provider: provider.name,
          providerMsgId: result.providerMessageId ?? null,
          attempts: { increment: 1 },
          error: null,
        },
      });
      return { ok: true };
    }

    const keepTrying = result.retryable && message.attempts < MAX_ATTEMPTS - 1;
    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: keepTrying ? "PENDING" : "FAILED",
        provider: provider.name,
        error: truncateError(result.error),
        attempts: { increment: 1 },
      },
    });
    return { ok: false, error: truncateError(result.error) };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[outbox] فشل الإرسال الفوري", messageId, detail);
    return { ok: false, error: "تعذّر الاتصال بمزوّد الرسائل" };
  }
}

// ─────────────────────────────── quiet hours ───────────────────────────────

/**
 * True while the current wall-clock time sits inside the quiet window.
 * Handles the 22:00 → 08:00 wrap; equal start/end means "no quiet hours".
 */
export function inQuietHours(
  s: { quietHoursStart?: string | null; quietHoursEnd?: string | null },
  now: Date = new Date(),
): boolean {
  const a = String(s?.quietHoursStart ?? "").trim();
  const b = String(s?.quietHoursEnd ?? "").trim();
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!valid.test(a) || !valid.test(b) || a === b) return false;

  const pad = (n: number) => String(n).padStart(2, "0");
  const current = `${pad(now.getHours())}:${pad(now.getMinutes())}`; // "23:40"

  return a <= b
    ? current >= a && current < b // 01:00 → 06:00
    : current >= a || current < b; // 22:00 → 08:00 (wraps midnight)
}

// ───────────────────────────────── preview ─────────────────────────────────

/** Plausible values for anything the caller cannot supply — used by the previewer. */
function sampleVars(settings: Setting): Record<string, unknown> {
  const today = todayIso();
  return {
    // attendance
    subject: "الرياضيات",
    class_name: "مجموعة السبت - ٣ ثانوي",
    date_ar: arDate(today),
    time_ar: arTime("16:00"),
    minutes_late: 15,
    // grades
    assessment_title: "اختبار الوحدة الأولى",
    score: 42,
    max_score: 100,
    percentage: "42.0",
    threshold: settings.lowGradeThreshold,
    // monthly report
    period_ar: arMonth(today.slice(0, 7)),
    sessions_total: 8,
    present_count: 6,
    absent_count: 1,
    late_count: 1,
    attendance_rate: 88,
    assessments_count: 3,
    average_percentage: "72.5",
    best_percentage: "88.0",
    worst_percentage: "55.0",
    teacher_note: "نتمنى له دوام التوفيق والتقدم.",
    // identity
    teacher_name: settings.tutorName,
    center_name: settings.centerName ?? "",
  };
}

/**
 * Renders a template without saving anything — powers `POST /api/messages/preview`
 * and the live preview in the Templates editor.
 *
 * With a `studentId` the real student, parent and class fill in; without one, sample
 * values are used so the teacher always sees a complete, realistic message.
 */
export async function renderPreview(templateKey: string, studentId?: string): Promise<string> {
  const [settings, template] = await Promise.all([
    getSettings(),
    prisma.messageTemplate.findUnique({ where: { key: templateKey } }),
  ]);

  if (!template) throw httpError(404, "القالب غير موجود");

  const vars: Record<string, unknown> = {
    ...sampleVars(settings),
    student_name: "أحمد محمود عبد الرحمن",
    parent_name: "محمود عبد الرحمن",
  };

  if (studentId) {
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      include: {
        enrollments: {
          where: { isActive: true },
          include: { classGroup: true },
          take: 1,
        },
      },
    });
    if (!student) throw httpError(404, "الطالب غير موجود");

    vars.student_name = student.name;
    vars.parent_name = student.parentName;

    const classGroup = student.enrollments[0]?.classGroup;
    if (classGroup) {
      vars.subject = classGroup.subject;
      vars.class_name = classGroup.name;
    }
  }

  return render(template.body, vars);
}
