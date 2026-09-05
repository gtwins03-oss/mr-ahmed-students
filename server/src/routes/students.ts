/**
 * /api/students — roster CRUD.
 *
 * Phone numbers are normalised to E.164 **on write** (never on read) using the
 * configured default country code, so "٠١٠٠١٢٣٤٥٦٧" and "0100 123 4567" both
 * land in the database as "+201001234567".
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../db";
import { arClass } from "../lib/arabic";
import { isValidE164, toE164 } from "../lib/phone";
import {
  badRequest,
  notFound,
  parseBody,
  queryBool,
  queryString,
  zIsoDate,
  zOptionalText,
} from "../lib/validate";
import { emitChange } from "../realtime";
import { logAudit } from "../services/audit.service";
import { studentReport } from "../services/reports.service";
import { getSettings } from "../services/settings.service";

const router = Router();

// ───────────────────────────── Shapes ──────────────────────────────────

const withClasses = {
  enrollments: {
    where: { isActive: true },
    include: { classGroup: { select: { id: true, name: true, color: true } } },
  },
} satisfies Prisma.StudentInclude;

type StudentRow = Prisma.StudentGetPayload<{ include: typeof withClasses }>;

function toStudentDto(row: StudentRow, sharedPhone = false) {
  const { enrollments, ...student } = row;
  return {
    ...student,
    classes: enrollments.map((e) => e.classGroup),
    sharedPhone,
  };
}

// ──────────────────────────── Validation ───────────────────────────────

const createSchema = z.object({
  name: z.string().trim().min(2, "اسم الطالب مطلوب").max(120),
  parentName: z.string().trim().min(2, "اسم ولي الأمر مطلوب").max(120),
  parentPhone: z.string().trim().min(6, "رقم هاتف ولي الأمر مطلوب").max(30),
  altPhone: z.string().trim().max(30).nullish(),
  gradeLevel: z.string().trim().min(1, "الصف الدراسي مطلوب").max(80),
  notes: zOptionalText(2000),
  isActive: z.boolean().optional(),
  classIds: z.array(z.string().trim().min(1)).optional(),
});

const updateSchema = createSchema.partial();

/** E.164 or a clear Arabic refusal — never store a number we cannot dial. */
function normalisePhone(raw: string, countryCode: string, label: string): string {
  const e164 = toE164(raw, countryCode);
  if (!isValidE164(e164)) {
    throw badRequest(`${label} غير صالح — تأكد من كتابة الرقم كاملاً`);
  }
  return e164;
}

/** Validates the selection and hands back the names the audit log will quote. */
async function assertClassesExist(classIds: string[]): Promise<string[]> {
  if (classIds.length === 0) return [];
  const found = await prisma.classGroup.findMany({
    where: { id: { in: classIds } },
    select: { name: true },
  });
  if (found.length !== new Set(classIds).size) {
    throw badRequest("إحدى المجموعات المختارة غير موجودة");
  }
  return found.map((c) => c.name);
}

// ─────────────────────── Arabic audit sentences ────────────────────────

const classNamesOf = (row: StudentRow): string[] =>
  row.enrollments.map((e) => e.classGroup.name);

/** "مجموعة السبت ومجموعة الأحد" — the list as a human would say it. */
const joinAr = (names: string[]): string => names.map(arClass).join(" و");

/**
 * One sentence per field that genuinely moved. The student is always named, and
 * a phone or a class shows both its old and its new value — never "تم التحديث".
 */
function describeStudentChange(before: StudentRow, after: StudentRow): string[] {
  const name = after.name;
  const parts: string[] = [];

  if (before.name !== after.name) {
    parts.push(`غيّر اسم الطالب من "${before.name}" إلى "${after.name}"`);
  }
  if (before.parentName !== after.parentName) {
    parts.push(`غيّر اسم ولي أمر "${name}" من "${before.parentName}" إلى "${after.parentName}"`);
  }
  if (before.parentPhone !== after.parentPhone) {
    parts.push(`غيّر رقم ولي أمر "${name}" من ${before.parentPhone} إلى ${after.parentPhone}`);
  }
  if ((before.altPhone ?? "") !== (after.altPhone ?? "")) {
    parts.push(
      after.altPhone
        ? `غيّر الهاتف البديل لـ"${name}" إلى ${after.altPhone}`
        : `مسح الهاتف البديل لـ"${name}"`,
    );
  }
  if (before.gradeLevel !== after.gradeLevel) {
    parts.push(`نقل "${name}" من ${before.gradeLevel} إلى ${after.gradeLevel}`);
  }
  if ((before.notes ?? "") !== (after.notes ?? "")) {
    parts.push(after.notes ? `عدّل ملاحظات "${name}"` : `مسح ملاحظات "${name}"`);
  }
  if (before.isActive !== after.isActive) {
    parts.push(
      after.isActive ? `أعاد تفعيل الطالب "${name}"` : `أرشف الطالب "${name}"`,
    );
  }

  const wasIn = classNamesOf(before);
  const isIn = classNamesOf(after);
  const added = isIn.filter((c) => !wasIn.includes(c));
  const removed = wasIn.filter((c) => !isIn.includes(c));
  if (added.length > 0) parts.push(`أضاف الطالب "${name}" إلى ${joinAr(added)}`);
  if (removed.length > 0) parts.push(`أزال الطالب "${name}" من ${joinAr(removed)}`);

  return parts;
}

/** The snapshot stored beside a student audit line. */
const studentSnapshot = (row: StudentRow): Record<string, unknown> => ({
  name: row.name,
  parentName: row.parentName,
  parentPhone: row.parentPhone,
  altPhone: row.altPhone,
  gradeLevel: row.gradeLevel,
  notes: row.notes,
  isActive: row.isActive,
  classes: classNamesOf(row),
});

// ─────────────────────────────── List ──────────────────────────────────

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = queryString(req, "q")?.trim();
    const classId = queryString(req, "classId");
    const active = queryBool(req, "active");

    const where: Prisma.StudentWhereInput = {};
    if (active !== undefined) where.isActive = active;
    if (classId) where.enrollments = { some: { classGroupId: classId, isActive: true } };

    if (q) {
      const digits = q.replace(/[^\d]/g, "");
      const or: Prisma.StudentWhereInput[] = [
        { name: { contains: q } },
        { parentName: { contains: q } },
        { gradeLevel: { contains: q } },
        { parentPhone: { contains: q } },
      ];
      if (digits.length >= 4) {
        or.push({ parentPhone: { contains: digits } }, { altPhone: { contains: digits } });
      }
      where.OR = or;
    }

    const [students, grouped] = await Promise.all([
      prisma.student.findMany({ where, include: withClasses }),
      prisma.student.groupBy({
        by: ["parentPhone"],
        where: { isActive: true },
        _count: { _all: true },
      }),
    ]);

    // Siblings legitimately share one number — flag it, never block it.
    const shared = new Set(
      grouped.filter((g) => g._count._all > 1).map((g) => g.parentPhone),
    );

    students.sort(
      (a, b) =>
        Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name, "ar"),
    );

    res.json(students.map((s) => toStudentDto(s, shared.has(s.parentPhone))));
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────── Detail ─────────────────────────────────

router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const student = await prisma.student.findUnique({ where: { id }, include: withClasses });
    if (!student) throw notFound("الطالب غير موجود");

    const [report, gradeRows, attendanceRows, samePhone] = await Promise.all([
      studentReport(id),
      prisma.grade.findMany({
        where: { studentId: id },
        include: {
          assessment: {
            include: { classGroup: { select: { id: true, name: true, subject: true, color: true } } },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 60,
      }),
      prisma.attendance.findMany({
        where: { studentId: id },
        include: {
          session: {
            include: { classGroup: { select: { id: true, name: true, subject: true, color: true } } },
          },
        },
        orderBy: { markedAt: "desc" },
        take: 60,
      }),
      prisma.student.count({
        where: { parentPhone: student.parentPhone, isActive: true, id: { not: id } },
      }),
    ]);

    const recentGrades = gradeRows
      .sort((a, b) => b.assessment.date.localeCompare(a.assessment.date))
      .slice(0, 10)
      .map((g) => ({
        id: g.id,
        assessmentId: g.assessmentId,
        title: g.assessment.title,
        type: g.assessment.type,
        date: g.assessment.date,
        maxScore: g.assessment.maxScore,
        score: g.score,
        percentage:
          g.score === null || g.assessment.maxScore <= 0
            ? null
            : Math.round((g.score / g.assessment.maxScore) * 1000) / 10,
        note: g.note,
        classGroup: g.assessment.classGroup,
      }));

    const recentAttendance = attendanceRows
      .sort((a, b) => b.session.date.localeCompare(a.session.date))
      .slice(0, 15)
      .map((a) => ({
        id: a.id,
        sessionId: a.sessionId,
        date: a.session.date,
        startTime: a.session.startTime,
        status: a.status,
        minutesLate: a.minutesLate,
        note: a.note,
        classGroup: a.session.classGroup,
      }));

    res.json({
      ...toStudentDto(student, samePhone > 0),
      report,
      recentGrades,
      recentAttendance,
    });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────── Report ─────────────────────────────────

router.get("/:id/report", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const exists = await prisma.student.count({ where: { id } });
    if (exists === 0) throw notFound("الطالب غير موجود");

    const raw = { from: queryString(req, "from"), to: queryString(req, "to") };
    const range = z
      .object({ from: zIsoDate.optional(), to: zIsoDate.optional() })
      .parse(raw);

    res.json(await studentReport(id, range.from, range.to));
  } catch (err) {
    if (err instanceof z.ZodError) return next(badRequest("نطاق التاريخ غير صالح"));
    next(err);
  }
});

// ────────────────────────────── Create ─────────────────────────────────

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = parseBody(createSchema, req);
    const settings = await getSettings();
    const cc = settings.defaultCountryCode;

    const parentPhone = normalisePhone(body.parentPhone, cc, "رقم هاتف ولي الأمر");
    const altPhone = body.altPhone
      ? normalisePhone(body.altPhone, cc, "رقم الهاتف البديل")
      : null;

    const classIds = body.classIds ?? [];
    const classNames = await assertClassesExist(classIds);

    const created = await prisma.$transaction(async (tx) => {
      const student = await tx.student.create({
        data: {
          name: body.name,
          parentName: body.parentName,
          parentPhone,
          altPhone,
          gradeLevel: body.gradeLevel,
          notes: body.notes ?? null,
          isActive: body.isActive ?? true,
        },
      });

      for (const classGroupId of new Set(classIds)) {
        await tx.enrollment.create({ data: { studentId: student.id, classGroupId } });
      }

      return tx.student.findUniqueOrThrow({
        where: { id: student.id },
        include: withClasses,
      });
    });

    await logAudit(req, {
      action: "CREATE",
      entity: "Student",
      entityId: created.id,
      summary: classNames.length
        ? `أضاف الطالب "${created.name}" إلى ${joinAr(classNames)}`
        : `أضاف الطالب "${created.name}"`,
      after: studentSnapshot(created),
    });
    emitChange("Student");

    res.status(201).json(toStudentDto(created));
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────── Update ─────────────────────────────────

router.patch("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const body = parseBody(updateSchema, req);

    // Read the whole row (classes included) *before* writing: the audit line
    // has to say what it changed from.
    const existing = await prisma.student.findUnique({ where: { id }, include: withClasses });
    if (!existing) throw notFound("الطالب غير موجود");

    const settings = await getSettings();
    const cc = settings.defaultCountryCode;

    const data: Prisma.StudentUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.parentName !== undefined) data.parentName = body.parentName;
    if (body.gradeLevel !== undefined) data.gradeLevel = body.gradeLevel;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.parentPhone !== undefined) {
      data.parentPhone = normalisePhone(body.parentPhone, cc, "رقم هاتف ولي الأمر");
    }
    if (body.altPhone !== undefined) {
      data.altPhone = body.altPhone
        ? normalisePhone(body.altPhone, cc, "رقم الهاتف البديل")
        : null;
    }

    if (body.classIds !== undefined) await assertClassesExist(body.classIds);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.student.update({ where: { id }, data });

      if (body.classIds !== undefined) {
        const keep = [...new Set(body.classIds)];
        await tx.enrollment.updateMany({
          where: keep.length
            ? { studentId: id, classGroupId: { notIn: keep } }
            : { studentId: id },
          data: { isActive: false },
        });
        for (const classGroupId of keep) {
          await tx.enrollment.upsert({
            where: { studentId_classGroupId: { studentId: id, classGroupId } },
            create: { studentId: id, classGroupId, isActive: true },
            update: { isActive: true },
          });
        }
      }

      return tx.student.findUniqueOrThrow({ where: { id }, include: withClasses });
    });

    const changes = describeStudentChange(existing, updated);
    if (changes.length > 0) {
      await logAudit(req, {
        action: "UPDATE",
        entity: "Student",
        entityId: id,
        summary: changes.join("، "),
        before: studentSnapshot(existing),
        after: studentSnapshot(updated),
      });
      emitChange("Student");
    }

    res.json(toStudentDto(updated));
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────── Delete ─────────────────────────────────

/**
 * Soft delete by default: a student with a year of attendance history must keep
 * that history, so they are simply hidden from the daily grid. `?hard=true`
 * really removes the row (and cascades their marks and grades).
 */
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const hard = queryBool(req, "hard") === true;

    const existing = await prisma.student.findUnique({ where: { id }, include: withClasses });
    if (!existing) throw notFound("الطالب غير موجود");

    if (hard) {
      await prisma.student.delete({ where: { id } });

      await logAudit(req, {
        action: "DELETE",
        entity: "Student",
        entityId: id,
        summary: `حذف الطالب "${existing.name}" نهائياً مع كل سجلاته`,
        before: studentSnapshot(existing),
      });
      emitChange("Student");

      return res.json({ ok: true, hard: true });
    }

    const student = await prisma.student.update({
      where: { id },
      data: { isActive: false },
      include: withClasses,
    });

    // Soft delete is the default: the history stays, the daily grid loses them.
    if (existing.isActive) {
      await logAudit(req, {
        action: "DELETE",
        entity: "Student",
        entityId: id,
        summary: `حذف الطالب "${existing.name}"`,
        before: studentSnapshot(existing),
        after: studentSnapshot(student),
      });
      emitChange("Student");
    }

    res.json({ ok: true, hard: false, student: toStudentDto(student) });
  } catch (err) {
    next(err);
  }
});

export default router;
