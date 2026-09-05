/**
 * /api/dashboard — the landing screen: today's classes, this week's attendance,
 * what is waiting to be sent, and the two lists worth acting on (students below
 * the grade threshold, and chronic absentees).
 */
import { Router, type Request, type Response, type NextFunction } from "express";

import { prisma } from "../db";
import { studentsReport } from "../services/reports.service";
import { getSettings } from "../services/settings.service";
import {
  addDaysISO,
  currentMonth,
  ensureSessions,
  getSessionsForDate,
  monthBounds,
  todayISO,
} from "../services/sessions.service";

const router = Router();

const LOW_PERFORMER_WINDOW_DAYS = 60;
const CHRONIC_ABSENCE_MIN = 3; // 3+ absences inside the current calendar month
const LIST_LIMIT = 10;

router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const today = todayISO();
    const weekFrom = addDaysISO(today, -6);
    const month = monthBounds(currentMonth());
    const gradeFrom = addDaysISO(today, -LOW_PERFORMER_WINDOW_DAYS);

    // Self-healing: if the 06:00 cron never ran (laptop was closed), build
    // today's sessions now so the board is never mysteriously empty.
    try {
      await ensureSessions(today);
    } catch (e) {
      console.error("[لوحة التحكم] تعذّر إنشاء حصص اليوم:", e);
    }

    const settings = await getSettings();

    const [
      todaySessions,
      weekAttendance,
      pendingMessages,
      activeStudents,
      absenceGroups,
      studentsTotal,
      classesTotal,
      assessmentsTotal,
    ] = await Promise.all([
      getSessionsForDate(today),
      prisma.attendance.findMany({
        where: { session: { date: { gte: weekFrom, lte: today } } },
        select: { status: true },
      }),
      prisma.message.count({ where: { status: "PENDING" } }),
      prisma.student.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      }),
      prisma.attendance.groupBy({
        by: ["studentId"],
        where: {
          status: "ABSENT",
          session: { date: { gte: month.from, lte: month.to } },
        },
        _count: { _all: true },
      }),
      prisma.student.count({ where: { isActive: true } }),
      prisma.classGroup.count({ where: { isActive: true } }),
      prisma.assessment.count(),
    ]);

    // ── attendance rate over the last 7 days ──
    const attended = weekAttendance.filter(
      (a) => a.status === "PRESENT" || a.status === "LATE",
    ).length;
    const weekAttendanceRate = weekAttendance.length
      ? Math.round((attended / weekAttendance.length) * 100)
      : 0;

    const nameById = new Map(activeStudents.map((s) => [s.id, s.name]));

    // ── students averaging below the threshold over the last 60 days ──
    const reports = await studentsReport(
      activeStudents.map((s) => s.id),
      gradeFrom,
      today,
    );

    const lowPerformers = activeStudents
      .map((s) => ({ student: s, report: reports.get(s.id) }))
      .filter(
        (r) =>
          r.report !== undefined &&
          r.report.assessmentsCount > 0 &&
          r.report.averagePercentage < settings.lowGradeThreshold,
      )
      .map((r) => ({
        studentId: r.student.id,
        name: r.student.name,
        averagePercentage: r.report?.averagePercentage ?? 0,
      }))
      .sort((a, b) => a.averagePercentage - b.averagePercentage)
      .slice(0, LIST_LIMIT);

    // ── 3+ absences this month, active students only ──
    const chronicAbsentees = absenceGroups
      .filter((g) => g._count._all >= CHRONIC_ABSENCE_MIN && nameById.has(g.studentId))
      .map((g) => ({
        studentId: g.studentId,
        name: nameById.get(g.studentId) ?? "",
        absentCount: g._count._all,
      }))
      .sort((a, b) => b.absentCount - a.absentCount || a.name.localeCompare(b.name, "ar"))
      .slice(0, LIST_LIMIT);

    res.json({
      todaySessions,
      weekAttendanceRate,
      pendingMessages,
      lowPerformers,
      chronicAbsentees,
      totals: {
        students: studentsTotal,
        classes: classesTotal,
        assessments: assessmentsTotal,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
