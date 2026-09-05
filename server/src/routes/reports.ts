/**
 * /api/reports — aggregation and the monthly parent report.
 *
 * Queueing is idempotent (`dedupeKey: REPORT:{month}:{studentId}`), so the
 * teacher's button and the 1st-of-the-month cron can both fire without any
 * parent receiving two reports.
 */
import { Router, type Request, type Response, type NextFunction } from "express";

import { prisma } from "../db";
import { notFound, parseValue, queryString, zIsoDate, zMonth } from "../lib/validate";
import {
  emptyReport,
  queueMonthlyReports,
  studentReport,
  studentsReport,
} from "../services/reports.service";
import { currentMonth, monthBounds } from "../services/sessions.service";

const router = Router();

/** `?month=` — defaults to the current local month. */
function readMonth(req: Request): string {
  const raw = queryString(req, "month");
  return raw ? parseValue(zMonth, raw) : currentMonth();
}

/** `?from=&to=` — inclusive bounds, either of which may be omitted. */
function readRange(req: Request): { from?: string; to?: string } {
  const from = queryString(req, "from");
  const to = queryString(req, "to");
  return {
    from: from ? parseValue(zIsoDate, from) : undefined,
    to: to ? parseValue(zIsoDate, to) : undefined,
  };
}

// ───────────────────────── Monthly report queue ────────────────────────

router.post("/monthly/queue", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const month = readMonth(req);
    // `req` so the audit line names the teacher; the cron passes null instead.
    res.json(await queueMonthlyReports(month, req));
  } catch (err) {
    next(err);
  }
});

// ────────────────────────── Roster-wide table ──────────────────────────

/**
 * One report row per active student — what the monthly screen previews before
 * the teacher queues anything, and what the dashboard's report table renders.
 *
 * `?month=YYYY-MM` (default: this month) or an explicit `?from=&to=` range.
 * Rows always carry the full set of numeric fields, zeroed for a student with
 * no history yet, so the table never has to null-check a cell.
 */
async function rosterReport(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const range = readRange(req);
    const month = range.from || range.to ? null : readMonth(req);
    const bounds = month ? monthBounds(month) : range;

    const students = await prisma.student.findMany({
      where: { isActive: true },
      select: { id: true, name: true, parentName: true, gradeLevel: true },
    });
    students.sort((a, b) => a.name.localeCompare(b.name, "ar"));

    const reports = await studentsReport(
      students.map((s) => s.id),
      bounds.from,
      bounds.to,
    );

    res.json({
      month,
      from: bounds.from ?? null,
      to: bounds.to ?? null,
      rows: students.map((s) => ({
        studentId: s.id,
        name: s.name,
        parentName: s.parentName,
        gradeLevel: s.gradeLevel,
        ...(reports.get(s.id) ?? emptyReport()),
      })),
    });
  } catch (err) {
    next(err);
  }
}

// `/students` is the range-first spelling of the same table; both stay so the
// UI can link to whichever reads better at the call site.
router.get("/monthly", rosterReport);
router.get("/students", rosterReport);

// ───────────────────────────── One student ─────────────────────────────

/** `?from=&to=` — omit both for the student's whole history. */
router.get("/student/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { from, to } = readRange(req);

    const student = await prisma.student.findUnique({
      where: { id },
      select: { id: true, name: true, parentName: true, gradeLevel: true },
    });
    if (!student) throw notFound("الطالب غير موجود");

    // The report is spread at the top level so a client typed as StudentReport
    // works unchanged; `student` and the bounds are extra context for the page.
    res.json({
      ...(await studentReport(id, from, to)),
      student,
      from: from ?? null,
      to: to ?? null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
