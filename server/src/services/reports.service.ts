/**
 * Attendance + grade aggregation per student (docs/03-roadmap.md, Phase 7)
 * and the monthly-report queue.
 *
 * The API speaks camelCase; the Arabic templates speak snake_case. The mapping
 * between the two lives in `reportVars()` and nowhere else.
 */
import type { Prisma } from "@prisma/client";
import type { Request } from "express";

import { prisma } from "../db";
import { arNum } from "../lib/arabic";
import { enqueueMessage } from "../messaging/outbox";
import { arMonth } from "../messaging/template";
import { emitChange } from "../realtime";
import { logAudit } from "./audit.service";
import { monthBounds } from "./sessions.service";

export type StudentReport = {
  sessionsTotal: number;
  presentCount: number;
  absentCount: number;
  lateCount: number;
  attendanceRate: number;
  assessmentsCount: number;
  averagePercentage: number;
  bestPercentage: number;
  worstPercentage: number;
};

type AttendanceRow = { status: string };
type GradeRow = { score: number | null; assessment: { maxScore: number } };

const round1 = (n: number): number => Math.round(n * 10) / 10;

export const emptyReport = (): StudentReport => ({
  sessionsTotal: 0,
  presentCount: 0,
  absentCount: 0,
  lateCount: 0,
  attendanceRate: 0,
  assessmentsCount: 0,
  averagePercentage: 0,
  bestPercentage: 0,
  worstPercentage: 0,
});

/** Inclusive `date` filter — omitted entirely when neither bound is given. */
function dateRange(from?: string, to?: string): Prisma.StringFilter | undefined {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
}

function computeReport(attendance: AttendanceRow[], grades: GradeRow[]): StudentReport {
  const count = (s: string): number => attendance.filter((a) => a.status === s).length;
  const total = attendance.length;
  const present = count("PRESENT");
  const late = count("LATE");

  const pcts = grades
    .filter((g) => g.score !== null && g.assessment.maxScore > 0)
    .map((g) => ((g.score as number) / g.assessment.maxScore) * 100);

  const average = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;

  return {
    sessionsTotal: total,
    presentCount: present,
    absentCount: count("ABSENT"),
    lateCount: late,
    attendanceRate: total ? Math.round(((present + late) / total) * 100) : 0,
    assessmentsCount: pcts.length,
    averagePercentage: round1(average),
    bestPercentage: pcts.length ? round1(Math.max(...pcts)) : 0,
    worstPercentage: pcts.length ? round1(Math.min(...pcts)) : 0,
  };
}

/** One student, optionally bounded by an inclusive date range. */
export async function studentReport(
  studentId: string,
  from?: string,
  to?: string,
): Promise<StudentReport> {
  const range = dateRange(from, to);

  const attendanceWhere: Prisma.AttendanceWhereInput = { studentId };
  if (range) attendanceWhere.session = { date: range };

  const gradeWhere: Prisma.GradeWhereInput = { studentId, score: { not: null } };
  if (range) gradeWhere.assessment = { date: range };

  const [attendance, grades] = await Promise.all([
    prisma.attendance.findMany({ where: attendanceWhere, select: { status: true } }),
    prisma.grade.findMany({
      where: gradeWhere,
      select: { score: true, assessment: { select: { maxScore: true } } },
    }),
  ]);

  return computeReport(attendance, grades);
}

/**
 * Same aggregation for many students in two queries instead of 2×N — used by
 * the dashboard and the monthly queue, where N is the whole roster.
 */
export async function studentsReport(
  studentIds: string[],
  from?: string,
  to?: string,
): Promise<Map<string, StudentReport>> {
  const result = new Map<string, StudentReport>();
  if (studentIds.length === 0) return result;

  const range = dateRange(from, to);

  const attendanceWhere: Prisma.AttendanceWhereInput = { studentId: { in: studentIds } };
  if (range) attendanceWhere.session = { date: range };

  const gradeWhere: Prisma.GradeWhereInput = {
    studentId: { in: studentIds },
    score: { not: null },
  };
  if (range) gradeWhere.assessment = { date: range };

  const [attendance, grades] = await Promise.all([
    prisma.attendance.findMany({
      where: attendanceWhere,
      select: { studentId: true, status: true },
    }),
    prisma.grade.findMany({
      where: gradeWhere,
      select: { studentId: true, score: true, assessment: { select: { maxScore: true } } },
    }),
  ]);

  const attendanceBy = new Map<string, AttendanceRow[]>();
  for (const a of attendance) {
    const list = attendanceBy.get(a.studentId) ?? [];
    list.push({ status: a.status });
    attendanceBy.set(a.studentId, list);
  }

  const gradesBy = new Map<string, GradeRow[]>();
  for (const g of grades) {
    const list = gradesBy.get(g.studentId) ?? [];
    list.push({ score: g.score, assessment: g.assessment });
    gradesBy.set(g.studentId, list);
  }

  for (const id of studentIds) {
    result.set(id, computeReport(attendanceBy.get(id) ?? [], gradesBy.get(id) ?? []));
  }
  return result;
}

/**
 * camelCase report → the snake_case placeholders used by the Arabic
 * MONTHLY_REPORT template. `periodAr` is already-formatted Arabic text.
 */
export function reportVars(
  report: StudentReport,
  periodAr: string,
  teacherNote = "",
): Record<string, unknown> {
  const graded = report.assessmentsCount > 0;
  const dash = "—";

  return {
    period_ar: periodAr,
    teacher_note: teacherNote,
    sessions_total: report.sessionsTotal,
    present_count: report.presentCount,
    absent_count: report.absentCount,
    late_count: report.lateCount,
    attendance_rate: report.attendanceRate,
    assessments_count: report.assessmentsCount,
    average_percentage: graded ? report.averagePercentage.toFixed(1) : dash,
    best_percentage: graded ? report.bestPercentage.toFixed(1) : dash,
    worst_percentage: graded ? report.worstPercentage.toFixed(1) : dash,
  };
}

/**
 * Queues a MONTHLY_REPORT for every active student.
 * `dedupeKey: REPORT:{month}:{studentId}` means running it twice — by cron on
 * the 1st and by the teacher's button — still sends one report per parent.
 *
 * `req` is null when the 1st-of-the-month cron calls it; the audit line then
 * records the system as the actor rather than a person.
 */
export async function queueMonthlyReports(
  month: string,
  req: Request | null = null,
): Promise<{ queued: number }> {
  const { from, to } = monthBounds(month);

  const students = await prisma.student.findMany({
    where: { isActive: true },
    select: { id: true },
    orderBy: { name: "asc" },
  });
  if (students.length === 0) return { queued: 0 };

  const ids = students.map((s) => s.id);
  const reports = await studentsReport(ids, from, to);
  const periodAr = arMonth(month);

  let queued = 0;
  for (const id of ids) {
    const result = await enqueueMessage({
      studentId: id,
      templateKey: "MONTHLY_REPORT",
      relatedType: "REPORT",
      relatedId: month,
      dedupeKey: `REPORT:${month}:${id}`,
      vars: reportVars(reports.get(id) ?? emptyReport(), periodAr),
    });
    // Only a *new* row counts: the dashboard reports this as «تمت إضافة {n}
    // تقرير إلى قائمة الإرسال», and the cron re-run on the 1st adds nothing.
    if (result?.created) queued += 1;
  }

  // The dedupeKey means a second run queues nothing — and a run that queued
  // nothing is not worth a line in the history.
  if (queued > 0) {
    await logAudit(req, {
      action: "MESSAGE",
      entity: "Message",
      entityId: null,
      summary: `جهّز تقارير شهر ${periodAr} لـ${arNum(queued)} من أولياء الأمور`,
      after: { month, queued },
    });
    emitChange("Message");
  }

  return { queued };
}
