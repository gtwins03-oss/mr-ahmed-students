/**
 * Attendance = the one screen the teacher touches every day, and the trigger
 * for absence / late alerts (docs/02-messaging.md §2.7).
 *
 * The grid saves as a single unit, and every alert carries a `dedupeKey`, so
 * re-saving the same marks ten times still messages each parent exactly once.
 *
 * The audit trail follows the same rule: the previous marks are read *before*
 * the upsert, and only students whose mark actually moved get a line. Saving an
 * unchanged grid writes no history at all.
 */
import type { Request } from "express";

import { prisma } from "../db";
import { arNum } from "../lib/arabic";
import { badRequest, notFound } from "../lib/validate";
import { enqueueMessage } from "../messaging/outbox";
import { arDate, arTime } from "../messaging/template";
import { emitChange } from "../realtime";
import { logAudit } from "./audit.service";
import { getSettings } from "./settings.service";
import type { AttendanceStatus } from "./sessions.service";

export type Mark = {
  studentId: string;
  status: AttendanceStatus;
  minutesLate?: number | null;
  note?: string | null;
};

export type SaveAttendanceResult = { saved: number; queued: number };

const STATUS_AR: Record<AttendanceStatus, string> = {
  PRESENT: "حاضر",
  ABSENT: "غائب",
  LATE: "متأخر",
  EXCUSED: "بعذر",
};

/** Never let an unexpected status code reach the log as a bare English word. */
const statusAr = (status: string): string => STATUS_AR[status as AttendanceStatus] ?? status;

export async function saveAttendance(
  sessionId: string,
  marks: Mark[],
  req: Request | null = null,
): Promise<SaveAttendanceResult> {
  // Last write wins if the client sent the same student twice.
  const unique = new Map<string, Mark>();
  for (const m of marks) unique.set(m.studentId, m);
  const list = [...unique.values()];

  const [settings, session] = await Promise.all([
    getSettings(),
    prisma.session.findUnique({
      where: { id: sessionId },
      include: { classGroup: true },
    }),
  ]);
  if (!session) throw notFound("الحصة غير موجودة");

  if (list.length === 0) return { saved: 0, queued: 0 };

  const studentIds = list.map((m) => m.studentId);

  // Reject unknown students up front — a foreign-key blow-up mid-transaction
  // would surface as an opaque 500. The names come back in the same query
  // because every audit line needs them.
  const known = await prisma.student.findMany({
    where: { id: { in: studentIds } },
    select: { id: true, name: true },
  });
  if (known.length !== list.length) {
    throw badRequest("بعض الطلاب في القائمة غير موجودين");
  }
  const nameOf = new Map(known.map((s) => [s.id, s.name]));

  // The marks as they stand *now* — read before the write so "من حاضر إلى
  // متأخر" describes what really happened.
  const previousRows = await prisma.attendance.findMany({
    where: { sessionId, studentId: { in: studentIds } },
  });
  const previous = new Map(previousRows.map((a) => [a.studentId, a]));

  // 1. Persist every mark atomically — the grid saves as one unit.
  const rows = await prisma.$transaction(
    list.map((m) =>
      prisma.attendance.upsert({
        where: { sessionId_studentId: { sessionId, studentId: m.studentId } },
        create: {
          sessionId,
          studentId: m.studentId,
          status: m.status,
          minutesLate: m.minutesLate ?? null,
          note: m.note ?? null,
        },
        update: {
          status: m.status,
          minutesLate: m.minutesLate ?? null,
          note: m.note ?? null,
          markedAt: new Date(),
        },
      }),
    ),
  );

  // 2. One audit line per student whose mark actually moved — a 30-student
  //    grid re-saved with two corrections writes two lines, not thirty.
  const subject = session.classGroup.subject;
  let changed = 0;

  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const prev = previous.get(m.studentId);
    const name = nameOf.get(m.studentId) ?? "طالب";
    const minutesLate = m.minutesLate ?? null;
    const note = m.note ?? null;

    let summary: string | null = null;
    if (!prev) {
      summary = `علّم "${name}" ${statusAr(m.status)} في حصة ${subject}`;
    } else if (prev.status !== m.status) {
      summary = `غيّر حضور "${name}" من ${statusAr(prev.status)} إلى ${statusAr(m.status)}`;
    } else if ((prev.minutesLate ?? null) !== minutesLate) {
      summary =
        minutesLate === null
          ? `مسح تأخير "${name}" في حصة ${subject}`
          : `سجّل تأخير "${name}" ${arNum(minutesLate)} دقيقة في حصة ${subject}`;
    } else if ((prev.note ?? null) !== note) {
      summary = note
        ? `أضاف ملاحظة على حضور "${name}": ${note}`
        : `مسح ملاحظة حضور "${name}" في حصة ${subject}`;
    }

    if (!summary) continue; // nothing moved for this student — log nothing
    changed += 1;

    await logAudit(req, {
      action: "ATTENDANCE",
      entity: "Attendance",
      entityId: rows[i]?.id ?? null,
      summary,
      before: prev
        ? { status: prev.status, minutesLate: prev.minutesLate, note: prev.note }
        : null,
      after: { status: m.status, minutesLate, note },
    });
  }

  if (changed > 0) emitChange("Attendance");

  // 3. Queue alerts. dedupeKey makes re-saving the grid harmless.
  let queued = 0;
  for (const m of list) {
    const wantsAlert =
      (m.status === "ABSENT" && settings.autoSendAbsence) ||
      (m.status === "LATE" && settings.autoSendLate);
    if (!wantsAlert) continue;

    const result = await enqueueMessage({
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
    });
    // Only a *new* row counts: the board reports this number as «تم إضافة {n}
    // رسالة إلى قائمة الإرسال», and a dedupeKey hit added nothing.
    if (result?.created) queued += 1;
  }

  if (queued > 0) emitChange("Message");

  return { saved: list.length, queued };
}
