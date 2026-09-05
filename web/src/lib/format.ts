/**
 * Arabic (ar-EG) formatting helpers.
 *
 * The whole UI renders Arabic-Indic digits, so every number that reaches the
 * screen should pass through `arNum` / `arPercent` rather than being
 * interpolated directly.
 *
 * Dates are plain "YYYY-MM-DD" text everywhere in this system — a class at 4pm
 * is at 4pm regardless of timezone. All parsing therefore appends "T00:00:00"
 * to stay in local time, and `todayISO()` is built from local getters instead
 * of `toISOString()`, which would roll over a day early east of UTC.
 */

import type { AttendanceStatus, AssessmentType, MessageStatus, SessionStatus } from "../api/types";

/**
 * The placeholder every formatter falls back to. Nothing in this module may
 * ever return "undefined", "null" or "NaN": those strings reach the DOM
 * verbatim and read as a broken app, whereas an em dash reads as "no value".
 */
const EM_DASH = "—";

/* ──────────────────────────────── Numbers ─────────────────────────────── */

const NUMBER_FORMAT = new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 1 });

/**
 * 12 → "١٢"  ·  87.5 → "٨٧٫٥"  ·  null / undefined / NaN → "—"
 *
 * The nullable parameter is deliberate. These values come off the wire, and a
 * column the server left null is typed `number` here more often than anyone
 * would like; formatting it must degrade to a dash, not print "null".
 * `Number(null)` and `Number("")` are both 0, so the empty cases are rejected
 * before the coercion rather than after it.
 */
export function arNum(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return EM_DASH;
  const value = typeof n === "number" ? n : Number(n);
  return Number.isFinite(value) ? NUMBER_FORMAT.format(value) : EM_DASH;
}

/** 87.5 → "٨٧٫٥٪"  ·  null / undefined / NaN → "—" (never "—٪"). */
export function arPercent(n: number | string | null | undefined): string {
  const text = arNum(n);
  return text === EM_DASH ? EM_DASH : `${text}٪`;
}

/* ───────────────────────────────── Dates ──────────────────────────────── */

const DATE_LONG = new Intl.DateTimeFormat("ar-EG", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const DATE_SHORT = new Intl.DateTimeFormat("ar-EG", {
  day: "numeric",
  month: "long",
});

const MONTH_LONG = new Intl.DateTimeFormat("ar-EG", {
  month: "long",
  year: "numeric",
});

const TIME_FORMAT = new Intl.DateTimeFormat("ar-EG", {
  hour: "numeric",
  minute: "2-digit",
});

const DATETIME_FORMAT = new Intl.DateTimeFormat("ar-EG", {
  day: "numeric",
  month: "long",
  hour: "numeric",
  minute: "2-digit",
});

/** Parses "2026-09-05" (or a full ISO timestamp) as a *local* date. */
function parseISODate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const datePart = iso.slice(0, 10);
  const d = new Date(`${datePart}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* Every date helper takes a nullable string for the same reason `arNum` does:
   a missing column must render as "—", not crash and not print "undefined". */

/** "2026-09-05" → "السبت ٥ سبتمبر ٢٠٢٦" */
export function arDate(iso: string | null | undefined): string {
  const d = parseISODate(iso);
  return d ? DATE_LONG.format(d) : EM_DASH;
}

/** "2026-09-05" → "٥ سبتمبر" */
export function arDateShort(iso: string | null | undefined): string {
  const d = parseISODate(iso);
  return d ? DATE_SHORT.format(d) : EM_DASH;
}

/** "2026-09" → "سبتمبر ٢٠٢٦" */
export function arMonth(ym: string | null | undefined): string {
  if (!ym) return EM_DASH;
  const d = new Date(`${ym.slice(0, 7)}-01T00:00:00`);
  return Number.isNaN(d.getTime()) ? EM_DASH : MONTH_LONG.format(d);
}

/** "16:00" → "٤:٠٠ م" */
export function arTime(hhmm: string | null | undefined): string {
  if (!hhmm) return EM_DASH;
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return EM_DASH;
  return TIME_FORMAT.format(new Date(2000, 0, 1, h, m));
}

/** A real instant (createdAt / sentAt) → "٥ سبتمبر ٤:٣٠ م" */
export function arDateTime(isoTimestamp: string | null | undefined): string {
  if (!isoTimestamp) return EM_DASH;
  const d = new Date(isoTimestamp);
  return Number.isNaN(d.getTime()) ? EM_DASH : DATETIME_FORMAT.format(d);
}

/**
 * Local-timezone-safe "today". `toISOString()` is deliberately avoided: it
 * converts to UTC and would return yesterday's date after 22:00 in Cairo.
 */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Current month as "YYYY-MM", local time. */
export function currentMonthISO(): string {
  return todayISO().slice(0, 7);
}

/** Shifts a "YYYY-MM-DD" string by whole days, staying in local time. */
export function addDaysISO(iso: string, days: number): string {
  const d = parseISODate(iso);
  if (!d) return iso;
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** 0 = Sunday … 6 = Saturday, matching `ScheduleSlot.weekday`. */
export function weekdayOf(iso: string): number {
  return parseISODate(iso)?.getDay() ?? 0;
}

export function isToday(iso: string): boolean {
  return iso === todayISO();
}

/* ──────────────────────────── Arabic vocabulary ───────────────────────── */

/** Index 0 = Sunday, matching `ScheduleSlot.weekday` and `Date.getDay()`. */
export const WEEKDAYS_AR: string[] = [
  "الأحد",
  "الاثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];

export const STATUS_AR: Record<AttendanceStatus, string> = {
  PRESENT: "حاضر",
  ABSENT: "غائب",
  LATE: "متأخر",
  EXCUSED: "بعذر",
};

/** Badge tone for each attendance status — keeps colour choices consistent. */
export const STATUS_TONE: Record<AttendanceStatus, "green" | "red" | "amber" | "blue"> = {
  PRESENT: "green",
  ABSENT: "red",
  LATE: "amber",
  EXCUSED: "blue",
};

export const MESSAGE_STATUS_AR: Record<MessageStatus, string> = {
  PENDING: "بانتظار الإرسال",
  SENT: "تم الإرسال",
  FAILED: "فشل الإرسال",
  SKIPPED: "تم التجاهل",
  CANCELLED: "ملغاة",
};

export const MESSAGE_STATUS_TONE: Record<
  MessageStatus,
  "green" | "red" | "amber" | "blue" | "gray"
> = {
  PENDING: "amber",
  SENT: "green",
  FAILED: "red",
  SKIPPED: "gray",
  CANCELLED: "gray",
};

export const SESSION_STATUS_AR: Record<SessionStatus, string> = {
  PLANNED: "مجدولة",
  HELD: "منعقدة",
  CANCELLED: "ملغاة",
};

export const ASSESSMENT_TYPE_AR: Record<AssessmentType, string> = {
  QUIZ: "اختبار قصير",
  EXAM: "امتحان",
  HOMEWORK: "واجب",
};
