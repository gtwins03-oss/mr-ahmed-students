/**
 * /api/assessments — quizzes, exams and homework, plus the score-entry grid.
 *
 * A blank score is `null` ("did not sit the test"): excluded from every average
 * and never alerted on. Saving scores queues LOW_GRADE alerts through the
 * grades service.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../db";
import { arClass, arNum } from "../lib/arabic";
import {
  badRequest,
  notFound,
  parseBody,
  queryString,
  zId,
  zIsoDate,
  zOptionalText,
} from "../lib/validate";
import { arDate } from "../messaging/template";
import { emitChange } from "../realtime";
import { logAudit } from "../services/audit.service";
import { saveGrades } from "../services/grades.service";
import { todayISO } from "../services/sessions.service";

const router = Router();

const ASSESSMENT_TYPES = ["QUIZ", "EXAM", "HOMEWORK"] as const;

/** Mirrors ASSESSMENT_TYPE_AR on the web side. */
const TYPE_AR: Record<string, string> = {
  QUIZ: "اختبار قصير",
  EXAM: "امتحان",
  HOMEWORK: "واجب",
};

const typeAr = (type: string): string => TYPE_AR[type] ?? type;

// ──────────────────────────── Validation ───────────────────────────────

const createSchema = z.object({
  classGroupId: zId,
  title: z.string().trim().min(2, "عنوان الاختبار مطلوب").max(160),
  type: z
    .enum(ASSESSMENT_TYPES, { errorMap: () => ({ message: "نوع الاختبار غير معروف" }) })
    .optional(),
  maxScore: z.coerce
    .number({ invalid_type_error: "الدرجة العظمى يجب أن تكون رقماً" })
    .positive("الدرجة العظمى يجب أن تكون أكبر من صفر")
    .max(10000, "الدرجة العظمى كبيرة جداً"),
  date: zIsoDate.optional(),
  weight: z.coerce.number().positive("الوزن يجب أن يكون أكبر من صفر").max(100).optional(),
});

const updateSchema = createSchema.partial().omit({ classGroupId: true });

/**
 * "" / null / a missing key → null ("did not sit the test").
 * "12.5" or 12.5 → 12.5. Anything else is rejected with an Arabic message.
 */
const scoreSchema = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((value, ctx): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && value.trim() === "") return null;

    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "الدرجة يجب أن تكون رقماً",
      });
      return z.NEVER;
    }
    if (n < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "الدرجة لا يمكن أن تكون سالبة",
      });
      return z.NEVER;
    }
    return n;
  });

const gradesSchema = z.object({
  entries: z
    .array(
      z.object({
        studentId: zId,
        score: scoreSchema,
        note: zOptionalText(500),
      }),
    )
    .max(300, "عدد الطلاب في الطلب كبير جداً"),
});

const round1 = (n: number): number => Math.round(n * 10) / 10;

const percentOf = (score: number | null, maxScore: number): number | null =>
  score === null || maxScore <= 0 ? null : round1((score / maxScore) * 100);

// ─────────────────────────────── List ──────────────────────────────────

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const classId = queryString(req, "classId");
    const from = queryString(req, "from");
    const to = queryString(req, "to");

    const where: Prisma.AssessmentWhereInput = {};
    if (classId) where.classGroupId = classId;
    if (from || to) {
      where.date = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    }

    const assessments = await prisma.assessment.findMany({
      where,
      include: {
        classGroup: { select: { id: true, name: true, subject: true } },
        grades: { select: { score: true } },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });

    res.json(
      assessments.map((a) => {
        const { grades, ...assessment } = a;
        const scored = grades.filter((g) => g.score !== null).map((g) => g.score as number);
        const average = scored.length
          ? scored.reduce((sum, s) => sum + s, 0) / scored.length
          : 0;

        return {
          ...assessment,
          gradedCount: scored.length,
          averagePercentage: scored.length ? percentOf(average, a.maxScore) ?? 0 : 0,
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ─────────────────────── Detail + score-entry grid ─────────────────────

router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const assessment = await prisma.assessment.findUnique({
      where: { id },
      include: {
        classGroup: { select: { id: true, name: true, subject: true, color: true, gradeLevel: true } },
        grades: { include: { student: true } },
      },
    });
    if (!assessment) throw notFound("الاختبار غير موجود");

    const enrollments = await prisma.enrollment.findMany({
      where: {
        classGroupId: assessment.classGroupId,
        isActive: true,
        student: { isActive: true },
      },
      include: { student: true },
    });

    // Enrolled students, plus anyone who already has a score but has since left
    // the group — their marks must stay visible and editable.
    const roster = new Map<string, { id: string; name: string }>();
    for (const e of enrollments) roster.set(e.student.id, e.student);
    for (const g of assessment.grades) roster.set(g.student.id, g.student);

    const gradeBy = new Map(assessment.grades.map((g) => [g.studentId, g]));

    const entries = [...roster.values()]
      .sort((a, b) => a.name.localeCompare(b.name, "ar"))
      .map((student) => {
        const grade = gradeBy.get(student.id);
        const score = grade?.score ?? null;
        return {
          studentId: student.id,
          name: student.name,
          score,
          percentage: percentOf(score, assessment.maxScore),
          note: grade?.note ?? null,
        };
      });

    const { grades, ...rest } = assessment;
    res.json({ ...rest, entries });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────── Create ─────────────────────────────────

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = parseBody(createSchema, req);

    const classGroup = await prisma.classGroup.findUnique({
      where: { id: body.classGroupId },
    });
    if (!classGroup) throw badRequest("المجموعة غير موجودة");

    const assessment = await prisma.assessment.create({
      data: {
        classGroupId: body.classGroupId,
        title: body.title,
        type: body.type ?? "QUIZ",
        maxScore: body.maxScore,
        date: body.date ?? todayISO(),
        weight: body.weight ?? 1,
      },
      include: { classGroup: { select: { id: true, name: true, subject: true } } },
    });

    await logAudit(req, {
      action: "CREATE",
      entity: "Assessment",
      entityId: assessment.id,
      summary: `أنشأ ${typeAr(assessment.type)} "${assessment.title}" ل${arClass(classGroup.name)} من ${arNum(assessment.maxScore)} درجة`,
      after: {
        title: assessment.title,
        type: assessment.type,
        maxScore: assessment.maxScore,
        date: assessment.date,
        weight: assessment.weight,
        classGroup: classGroup.name,
      },
    });
    emitChange("Assessment");

    res.status(201).json({ ...assessment, gradedCount: 0, averagePercentage: 0 });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────── Update ─────────────────────────────────

router.patch("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const body = parseBody(updateSchema, req);

    const existing = await prisma.assessment.findUnique({ where: { id } });
    if (!existing) throw notFound("الاختبار غير موجود");

    const updated = await prisma.assessment.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.maxScore !== undefined ? { maxScore: body.maxScore } : {}),
        ...(body.date !== undefined ? { date: body.date } : {}),
        ...(body.weight !== undefined ? { weight: body.weight } : {}),
      },
      include: {
        classGroup: { select: { id: true, name: true, subject: true } },
        grades: { select: { score: true } },
      },
    });

    const title = updated.title;
    const changes: string[] = [];

    if (existing.title !== updated.title) {
      changes.push(`غيّر عنوان الاختبار من "${existing.title}" إلى "${updated.title}"`);
    }
    if (existing.type !== updated.type) {
      changes.push(`غيّر نوع "${title}" من ${typeAr(existing.type)} إلى ${typeAr(updated.type)}`);
    }
    if (existing.maxScore !== updated.maxScore) {
      changes.push(
        `غيّر الدرجة العظمى لـ"${title}" من ${arNum(existing.maxScore)} إلى ${arNum(updated.maxScore)}`,
      );
    }
    if (existing.date !== updated.date) {
      changes.push(`غيّر تاريخ "${title}" من ${arDate(existing.date)} إلى ${arDate(updated.date)}`);
    }
    if (existing.weight !== updated.weight) {
      changes.push(`غيّر وزن "${title}" من ${arNum(existing.weight)} إلى ${arNum(updated.weight)}`);
    }

    if (changes.length > 0) {
      await logAudit(req, {
        action: "UPDATE",
        entity: "Assessment",
        entityId: id,
        summary: changes.join("، "),
        before: {
          title: existing.title,
          type: existing.type,
          maxScore: existing.maxScore,
          date: existing.date,
          weight: existing.weight,
        },
        after: {
          title: updated.title,
          type: updated.type,
          maxScore: updated.maxScore,
          date: updated.date,
          weight: updated.weight,
        },
      });
      emitChange("Assessment");
    }

    const { grades, ...assessment } = updated;
    const scored = grades.filter((g) => g.score !== null).map((g) => g.score as number);
    const average = scored.length ? scored.reduce((s, x) => s + x, 0) / scored.length : 0;

    res.json({
      ...assessment,
      gradedCount: scored.length,
      averagePercentage: scored.length ? percentOf(average, updated.maxScore) ?? 0 : 0,
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const existing = await prisma.assessment.findUnique({
      where: { id },
      include: { grades: { select: { id: true } } },
    });
    if (!existing) throw notFound("الاختبار غير موجود");

    await prisma.assessment.delete({ where: { id } });

    await logAudit(req, {
      action: "DELETE",
      entity: "Assessment",
      entityId: id,
      summary: existing.grades.length
        ? `حذف ${typeAr(existing.type)} "${existing.title}" و${arNum(existing.grades.length)} درجة مسجّلة عليه`
        : `حذف ${typeAr(existing.type)} "${existing.title}"`,
      before: {
        title: existing.title,
        type: existing.type,
        maxScore: existing.maxScore,
        date: existing.date,
        gradesCount: existing.grades.length,
      },
    });
    emitChange("Assessment");

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────── Score entry ──────────────────────────────

router.post("/:id/grades", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { entries } = parseBody(gradesSchema, req);

    // The service owns the audit lines: it is the only place that knows which
    // students' scores actually moved.
    const result = await saveGrades(
      req.params.id,
      entries.map((e) => ({ studentId: e.studentId, score: e.score, note: e.note })),
      req,
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
