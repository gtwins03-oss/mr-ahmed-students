/**
 * Sessions = dated occurrences of a class, materialised from the weekly
 * ScheduleSlot rows (docs/03-roadmap.md, Phase 2).
 *
 * This module also owns the app's **local** date helpers. `toISOString()` is
 * never used for calendar dates: at UTC+02:00 it turns "2026-09-05 01:00" into
 * "2026-09-04", which silently files attendance under the wrong day.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "../db";

// ───────────────────────────── Date helpers ────────────────────────────

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local calendar date of a JS Date → "2026-09-05". Never UTC. */
export function toISODate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today, in the server's local timezone. */
export function todayISO(d: Date = new Date()): string {
  return toISODate(d);
}

/** "2026-09-05" → a local midnight Date (no timezone shifting). */
export function isoToDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

/** "2026-09-05" + 7 → "2026-09-12" (handles month/year rollover). */
export function addDaysISO(iso: string, days: number): string {
  const d = isoToDate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** "2026-09-05" → "2026-09" */
export function monthOfISO(iso: string): string {
  return iso.slice(0, 7);
}

/** Current month, local → "2026-09" */
export function currentMonth(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** The month before `d` → "2026-08" when `d` is in September 2026. */
export function previousMonth(d: Date = new Date()): string {
  const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${first.getFullYear()}-${pad(first.getMonth() + 1)}`;
}

/** "2026-09" → { from: "2026-09-01", to: "2026-09-30" } */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last of this
  return { from: `${month}-01`, to: `${month}-${pad(lastDay)}` };
}

// ────────────────────────────── View types ─────────────────────────────

export type AttendanceStatus = "PRESENT" | "ABSENT" | "LATE" | "EXCUSED";

export type RosterEntry = {
  studentId: string;
  name: string;
  parentName: string;
  parentPhone: string;
  gradeLevel: string;
  status: AttendanceStatus | null;
  minutesLate: number | null;
  note: string | null;
};

export type SessionCounts = {
  present: number;
  absent: number;
  late: number;
  excused: number;
  unmarked: number;
  total: number;
};

export type SessionView = {
  id: string;
  date: string;
  startTime: string;
  endTime: string | null;
  topic: string | null;
  status: string;
  classGroup: {
    id: string;
    name: string;
    subject: string;
    color: string;
    gradeLevel: string;
  };
  roster: RosterEntry[];
  counts: SessionCounts;
};

type SessionWithRelations = Prisma.SessionGetPayload<{
  include: { classGroup: true; attendance: true };
}>;

// ────────────────────────── Session materialisation ────────────────────

/**
 * Idempotently creates the sessions implied by the weekly schedule for `date`.
 * Safe to call as often as you like — `@@unique([classGroupId, date,
 * startTime])` collapses repeats. Returns how many rows were *newly* created.
 */
export async function ensureSessions(date: string): Promise<number> {
  const weekday = isoToDate(date).getDay(); // 0 = Sunday … 6 = Saturday

  const slots = await prisma.scheduleSlot.findMany({
    where: { weekday, classGroup: { isActive: true } },
  });
  if (slots.length === 0) return 0;

  const existing = await prisma.session.findMany({
    where: { date, classGroupId: { in: slots.map((s) => s.classGroupId) } },
    select: { classGroupId: true, startTime: true },
  });
  const already = new Set(existing.map((e) => `${e.classGroupId}|${e.startTime}`));

  let created = 0;
  // Sequential on purpose: SQLite serialises writes anyway, and a parallel
  // burst of upserts is the classic source of "database is locked".
  for (const slot of slots) {
    if (!already.has(`${slot.classGroupId}|${slot.startTime}`)) created += 1;

    await prisma.session.upsert({
      where: {
        classGroupId_date_startTime: {
          classGroupId: slot.classGroupId,
          date,
          startTime: slot.startTime,
        },
      },
      update: {}, // never touch a session the teacher already edited
      create: {
        classGroupId: slot.classGroupId,
        date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: "HELD",
      },
    });
  }

  return created;
}

// ──────────────────────────── Day / roster view ────────────────────────

/**
 * Builds the full `{ ...session, classGroup, roster, counts }` payload the
 * attendance board renders. The roster is every *active enrolled* student of
 * the class, left-joined with their mark for that session (`status: null` when
 * nobody has marked them yet).
 */
async function buildSessionViews(sessions: SessionWithRelations[]): Promise<SessionView[]> {
  if (sessions.length === 0) return [];

  const classIds = [...new Set(sessions.map((s) => s.classGroupId))];

  const enrollments = await prisma.enrollment.findMany({
    where: {
      classGroupId: { in: classIds },
      isActive: true,
      student: { isActive: true },
    },
    include: { student: true },
  });

  const rosterByClass = new Map<string, typeof enrollments>();
  for (const e of enrollments) {
    const list = rosterByClass.get(e.classGroupId) ?? [];
    list.push(e);
    rosterByClass.set(e.classGroupId, list);
  }
  for (const list of rosterByClass.values()) {
    list.sort((a, b) => a.student.name.localeCompare(b.student.name, "ar"));
  }

  return sessions.map((session) => {
    const marks = new Map(session.attendance.map((a) => [a.studentId, a]));
    const roster: RosterEntry[] = (rosterByClass.get(session.classGroupId) ?? []).map((e) => {
      const mark = marks.get(e.studentId);
      return {
        studentId: e.student.id,
        name: e.student.name,
        parentName: e.student.parentName,
        parentPhone: e.student.parentPhone,
        gradeLevel: e.student.gradeLevel,
        status: (mark?.status as AttendanceStatus | undefined) ?? null,
        minutesLate: mark?.minutesLate ?? null,
        note: mark?.note ?? null,
      };
    });

    const tally = (status: AttendanceStatus): number =>
      roster.filter((r) => r.status === status).length;

    const counts: SessionCounts = {
      present: tally("PRESENT"),
      absent: tally("ABSENT"),
      late: tally("LATE"),
      excused: tally("EXCUSED"),
      unmarked: roster.filter((r) => r.status === null).length,
      total: roster.length,
    };

    return {
      id: session.id,
      date: session.date,
      startTime: session.startTime,
      endTime: session.endTime,
      topic: session.topic,
      status: session.status,
      classGroup: {
        id: session.classGroup.id,
        name: session.classGroup.name,
        subject: session.classGroup.subject,
        color: session.classGroup.color,
        gradeLevel: session.classGroup.gradeLevel,
      },
      roster,
      counts,
    };
  });
}

/** Every session on `date`, optionally narrowed to one class. */
export async function getSessionsForDate(
  date: string,
  classId?: string,
): Promise<SessionView[]> {
  const sessions = await prisma.session.findMany({
    where: { date, ...(classId ? { classGroupId: classId } : {}) },
    include: { classGroup: true, attendance: true },
    orderBy: { startTime: "asc" },
  });

  const views = await buildSessionViews(sessions);
  return views.sort(
    (a, b) =>
      a.startTime.localeCompare(b.startTime) ||
      a.classGroup.name.localeCompare(b.classGroup.name, "ar"),
  );
}

/** One session in the same shape as the day view — or null when it is gone. */
export async function getSessionById(sessionId: string): Promise<SessionView | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { classGroup: true, attendance: true },
  });
  if (!session) return null;

  const [view] = await buildSessionViews([session]);
  return view ?? null;
}
