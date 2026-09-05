# 2 — Messaging: providers, templates, and the outbox

## 2.1 The port

Everything that can send a message implements one interface. Nothing else in the codebase
knows which provider is active.

```ts
// server/src/messaging/provider.ts
export type SendResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; error: string; retryable: boolean };

export interface MessagingProvider {
  readonly name: "WA_LINK" | "GREEN_API" | "TWILIO";
  /** Can this provider deliver without a human? Tier 0 cannot. */
  readonly autonomous: boolean;
  send(toE164: string, body: string): Promise<SendResult>;
}
```

## 2.2 Phone normalisation

Parents type numbers as `01001234567`, `0100 123 4567`, `+20 100 123 4567`, or in
Arabic-Indic digits `٠١٠٠١٢٣٤٥٦٧`. WhatsApp needs one canonical form. Normalise **on write**,
never on read.

```ts
// server/src/lib/phone.ts
const ARABIC_INDIC = /[٠-٩]/g; // ٠-٩
const EASTERN_ARABIC = /[۰-۹]/g; // ۰-۹

/** "٠١٠٠١٢٣٤٥٦٧" | "0100 123 4567" | "0020100…" → "+201001234567" */
export function toE164(raw: string, defaultCountryCode = "+20"): string {
  const ascii = raw
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EASTERN_ARABIC, (d) => String(d.charCodeAt(0) - 0x06f0));

  let s = ascii.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("+")) return s;
  return defaultCountryCode + s.replace(/^0+/, "");
}

export function isValidE164(s: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(s);
}

/** Green API / WhatsApp Web chat id */
export const toChatId = (e164: string) => `${e164.replace(/\D/g, "")}@c.us`;

/** Tier 0 click-to-chat link. Note: no "+" in the path. */
export const toWaLink = (e164: string, body: string) =>
  `https://wa.me/${e164.replace(/\D/g, "")}?text=${encodeURIComponent(body)}`;
```

## 2.3 Template engine

```ts
// server/src/messaging/template.ts
export function render(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** "2026-09-05" → "السبت ٥ سبتمبر ٢٠٢٦" */
export function arDate(isoDate: string): string {
  return new Intl.DateTimeFormat("ar-EG", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(new Date(`${isoDate}T00:00:00`));
}

/** "2026-09" → "سبتمبر ٢٠٢٦" */
export function arMonth(ym: string): string {
  return new Intl.DateTimeFormat("ar-EG", { month: "long", year: "numeric" })
    .format(new Date(`${ym}-01T00:00:00`));
}

/** "16:00" → "٤:٠٠ م" */
export function arTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(2000, 0, 1, h, m);
  return new Intl.DateTimeFormat("ar-EG", { hour: "numeric", minute: "2-digit" }).format(d);
}
```

## 2.4 The Arabic templates (seed data)

These go into `message_templates` and are editable from the Settings screen — the teacher
should never need a developer to reword a message.

### `ABSENCE` — تنبيه غياب

```
السلام عليكم ورحمة الله وبركاته
عزيزي ولي أمر الطالب/ة: {{student_name}}

نود إحاطتكم علماً بأن الطالب/ة تغيّب اليوم عن حصة {{subject}}
📅 التاريخ: {{date_ar}}
🕐 الموعد: {{time_ar}}

نرجو المتابعة والتواصل معنا لأي استفسار.
مع خالص التقدير،
{{teacher_name}}
```

### `LATE` — تنبيه تأخير

```
السلام عليكم ورحمة الله وبركاته
عزيزي ولي أمر الطالب/ة: {{student_name}}

نفيدكم بأن الطالب/ة حضر متأخراً بمقدار {{minutes_late}} دقيقة
عن حصة {{subject}} يوم {{date_ar}}.

نرجو الحرص على الحضور في الموعد المحدد حفاظاً على استفادته الكاملة.
مع خالص التقدير،
{{teacher_name}}
```

### `LOW_GRADE` — تنبيه مستوى

```
السلام عليكم ورحمة الله وبركاته
عزيزي ولي أمر الطالب/ة: {{student_name}}

نتيجة «{{assessment_title}}» في مادة {{subject}} بتاريخ {{date_ar}}:
📊 الدرجة: {{score}} من {{max_score}}  ({{percentage}}%)

الدرجة أقل من المستوى المطلوب ({{threshold}}%). نرجو المتابعة معه في المنزل،
ونحن على استعداد لتقديم حصة تقوية إضافية إذا رغبتم.

مع خالص التقدير،
{{teacher_name}}
```

### `MONTHLY_REPORT` — التقرير الشهري

```
السلام عليكم ورحمة الله وبركاته
تقرير الطالب/ة: {{student_name}}
📆 الفترة: {{period_ar}}

▪️ الحضور
• عدد الحصص: {{sessions_total}}
• حضور: {{present_count}}
• غياب: {{absent_count}}
• تأخير: {{late_count}}
• نسبة الحضور: {{attendance_rate}}%

▪️ المستوى الدراسي
• عدد الاختبارات: {{assessments_count}}
• المتوسط العام: {{average_percentage}}%
• أعلى درجة: {{best_percentage}}%
• أقل درجة: {{worst_percentage}}%

{{teacher_note}}
شاكرين لكم حسن تعاونكم،
{{teacher_name}}
```

**Placeholder contract** — the UI validates that a saved template only uses keys the system
can supply. Unknown `{{keys}}` render as empty strings rather than throwing, so a typo
degrades gracefully instead of blocking a send.

## 2.5 The three adapters

### Tier 0 — `wa.me` link (default, free, zero setup)

```ts
// server/src/messaging/wa-link.ts
import type { MessagingProvider, SendResult } from "./provider.js";

/** Cannot send by itself. Messages stay PENDING until the teacher taps Send
 *  in the Send Queue UI, which opens the link and then calls /mark-sent. */
export const waLinkProvider: MessagingProvider = {
  name: "WA_LINK",
  autonomous: false,
  async send(): Promise<SendResult> {
    return { ok: false, error: "MANUAL_PROVIDER", retryable: false };
  },
};
```

### Tier 1 — Green API (recommended once volume justifies it)

Setup: create an instance at green-api.com, scan the QR with the teacher's WhatsApp, copy
`idInstance` + `apiTokenInstance` into Settings.

```ts
// server/src/messaging/green-api.ts
import { toChatId } from "../lib/phone.js";
import type { MessagingProvider, SendResult } from "./provider.js";

export function greenApiProvider(cfg: {
  idInstance: string;
  apiTokenInstance: string;
  apiUrl?: string;
}): MessagingProvider {
  const base = cfg.apiUrl ?? "https://api.green-api.com";
  return {
    name: "GREEN_API",
    autonomous: true,
    async send(toE164, body): Promise<SendResult> {
      const url = `${base}/waInstance${cfg.idInstance}/sendMessage/${cfg.apiTokenInstance}`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: toChatId(toE164), message: body }),
        });
        const text = await res.text();
        if (!res.ok) {
          // 4xx = bad number/credentials (don't retry); 5xx/429 = transient
          return { ok: false, error: `${res.status} ${text}`, retryable: res.status >= 500 || res.status === 429 };
        }
        const data = JSON.parse(text) as { idMessage?: string };
        return { ok: true, providerMessageId: data.idMessage };
      } catch (e) {
        return { ok: false, error: String(e), retryable: true }; // network blip
      }
    },
  };
}
```

### Tier 2 — Twilio (official, for SMS or approved WhatsApp templates)

```ts
// server/src/messaging/twilio.ts
import twilio from "twilio";
import type { MessagingProvider, SendResult } from "./provider.js";

export function twilioProvider(cfg: {
  accountSid: string; authToken: string; from: string; channel: "WHATSAPP" | "SMS";
}): MessagingProvider {
  const client = twilio(cfg.accountSid, cfg.authToken);
  const wrap = (n: string) => (cfg.channel === "WHATSAPP" ? `whatsapp:${n}` : n);
  return {
    name: "TWILIO",
    autonomous: true,
    async send(toE164, body): Promise<SendResult> {
      try {
        const msg = await client.messages.create({
          from: wrap(cfg.from), to: wrap(toE164), body,
        });
        return { ok: true, providerMessageId: msg.sid };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e), retryable: e?.status >= 500 };
      }
    },
  };
}
```

> ⚠️ **Twilio WhatsApp caveat.** Outside a 24-hour window opened by the parent, Meta only
> permits *pre-approved template* messages, sent with `contentSid` + `contentVariables` —
> not free-form `body`. Your four Arabic templates must be submitted and approved first.
> This is the main reason Tier 2 takes days rather than minutes, and why Tier 1 is the
> pragmatic middle ground for a single tutor.

## 2.6 The outbox

`enqueueMessage` is the **only** function in the codebase that creates a parent notification.

```ts
// server/src/messaging/outbox.ts
import { prisma } from "../db.js";
import { getSettings } from "../services/settings.service.js";
import { render } from "./template.js";
import { resolveProvider } from "./index.js";

type EnqueueInput = {
  studentId: string;
  templateKey: "ABSENCE" | "LATE" | "LOW_GRADE" | "MONTHLY_REPORT";
  vars: Record<string, unknown>;
  relatedType: "ATTENDANCE" | "GRADE" | "REPORT";
  relatedId: string;
  /** Idempotency key — the same real-world event never messages twice. */
  dedupeKey: string;
};

export async function enqueueMessage(input: EnqueueInput) {
  const [settings, student, template] = await Promise.all([
    getSettings(),
    prisma.student.findUnique({ where: { id: input.studentId } }),
    prisma.messageTemplate.findUnique({ where: { key: input.templateKey } }),
  ]);
  if (!student || !student.isActive || !template?.isActive) return null;

  const body = render(template.body, {
    student_name: student.name,
    parent_name: student.parentName,
    teacher_name: settings.tutorName,
    threshold: settings.lowGradeThreshold,
    ...input.vars,
  });

  // Unique dedupeKey does the work: a second enqueue for the same event is a no-op.
  return prisma.message.upsert({
    where: { dedupeKey: input.dedupeKey },
    update: {}, // deliberately empty — never rewrite an already-queued message
    create: {
      studentId: student.id,
      toPhone: student.parentPhone,
      channel: "WHATSAPP",
      templateKey: input.templateKey,
      body,
      status: "PENDING",
      relatedType: input.relatedType,
      relatedId: input.relatedId,
      dedupeKey: input.dedupeKey,
    },
  });
}

/** Runs every 2 minutes (cron). No-op when the active provider is Tier 0. */
export async function drainOutbox(limit = 20) {
  const settings = await getSettings();
  const provider = resolveProvider(settings);
  if (!provider.autonomous) return { skipped: "manual-provider" };
  if (inQuietHours(settings)) return { skipped: "quiet-hours" };

  const batch = await prisma.message.findMany({
    where: { status: "PENDING", attempts: { lt: 5 } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  for (const m of batch) {
    const result = await provider.send(m.toPhone, m.body);
    await prisma.message.update({
      where: { id: m.id },
      data: result.ok
        ? { status: "SENT", sentAt: new Date(), provider: provider.name,
            providerMsgId: result.providerMessageId, attempts: { increment: 1 }, error: null }
        : { status: result.retryable && m.attempts < 4 ? "PENDING" : "FAILED",
            provider: provider.name, error: result.error, attempts: { increment: 1 } },
    });
    await new Promise((r) => setTimeout(r, 1500)); // throttle: bursts look like spam
  }
  return { processed: batch.length };
}

function inQuietHours(s: { quietHoursStart: string; quietHoursEnd: string }) {
  const now = new Date().toTimeString().slice(0, 5); // "23:40"
  const { quietHoursStart: a, quietHoursEnd: b } = s;
  return a <= b ? now >= a && now < b : now >= a || now < b; // handles 22:00→08:00 wrap
}
```

**Why the throttle matters:** sending 30 identical-looking messages in 3 seconds from a
personal number is the fastest way to get it flagged. 1.5s spacing plus quiet hours keeps
the traffic human-shaped.

## 2.7 Where alerts are triggered

```ts
// server/src/services/attendance.service.ts
import { prisma } from "../db.js";
import { getSettings } from "./settings.service.js";
import { enqueueMessage } from "../messaging/outbox.js";
import { arDate, arTime } from "../messaging/template.js";

type Mark = {
  studentId: string;
  status: "PRESENT" | "ABSENT" | "LATE" | "EXCUSED";
  minutesLate?: number;
  note?: string;
};

export async function saveAttendance(sessionId: string, marks: Mark[]) {
  const [settings, session] = await Promise.all([
    getSettings(),
    prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: { classGroup: true },
    }),
  ]);

  // 1. Persist every mark atomically — the grid saves as one unit.
  await prisma.$transaction(
    marks.map((m) =>
      prisma.attendance.upsert({
        where: { sessionId_studentId: { sessionId, studentId: m.studentId } },
        create: { sessionId, studentId: m.studentId, status: m.status,
                  minutesLate: m.minutesLate ?? null, note: m.note ?? null },
        update: { status: m.status, minutesLate: m.minutesLate ?? null,
                  note: m.note ?? null, markedAt: new Date() },
      }),
    ),
  );

  // 2. Queue alerts. dedupeKey makes re-saving the grid harmless.
  const queued = [];
  for (const m of marks) {
    const wantsAlert =
      (m.status === "ABSENT" && settings.autoSendAbsence) ||
      (m.status === "LATE" && settings.autoSendLate);
    if (!wantsAlert) continue;

    queued.push(
      await enqueueMessage({
        studentId: m.studentId,
        templateKey: m.status === "ABSENT" ? "ABSENCE" : "LATE",
        relatedType: "ATTENDANCE",
        relatedId: sessionId,
        dedupeKey: `${m.status}:${sessionId}:${m.studentId}`,
        vars: {
          subject: session.classGroup.subject,
          class_name: session.classGroup.name,
          date_ar: arDate(session.date),
          time_ar: arTime(session.startTime),
          minutes_late: m.minutesLate ?? 0,
        },
      }),
    );
  }
  return { saved: marks.length, queued: queued.filter(Boolean).length };
}
```

```ts
// server/src/services/grades.service.ts — the low-score rule
export async function saveGrades(
  assessmentId: string,
  entries: { studentId: string; score: number | null; note?: string }[],
) {
  const [settings, assessment] = await Promise.all([
    getSettings(),
    prisma.assessment.findUniqueOrThrow({
      where: { id: assessmentId },
      include: { classGroup: true },
    }),
  ]);

  await prisma.$transaction(
    entries.map((e) =>
      prisma.grade.upsert({
        where: { assessmentId_studentId: { assessmentId, studentId: e.studentId } },
        create: { assessmentId, studentId: e.studentId, score: e.score, note: e.note ?? null },
        update: { score: e.score, note: e.note ?? null },
      }),
    ),
  );

  if (!settings.autoSendLowGrade) return { saved: entries.length, queued: 0 };

  let queued = 0;
  for (const e of entries) {
    if (e.score === null) continue; // absent from the test ≠ a low grade
    const pct = (e.score / assessment.maxScore) * 100;
    if (pct >= settings.lowGradeThreshold) continue;

    const msg = await enqueueMessage({
      studentId: e.studentId,
      templateKey: "LOW_GRADE",
      relatedType: "GRADE",
      relatedId: assessmentId,
      dedupeKey: `LOW_GRADE:${assessmentId}:${e.studentId}`,
      vars: {
        assessment_title: assessment.title,
        subject: assessment.classGroup.subject,
        date_ar: arDate(assessment.date),
        score: e.score,
        max_score: assessment.maxScore,
        percentage: pct.toFixed(1),
      },
    });
    if (msg) queued++;
  }
  return { saved: entries.length, queued };
}
```

Note the deliberate choice: a *corrected* score that is still below threshold does **not**
re-notify, because the `dedupeKey` already exists. If you later want "notify again when a
grade is edited downward", make the key include the score — but the default of one message
per test per student is what a parent actually wants.
