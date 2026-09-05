/**
 * /api/classes — class groups, their weekly schedule slots, and enrolment.
 *
 * A class carries its `slots` (the weekly timetable the session generator reads)
 * and a `studentCount`. Replacing the slot set is transactional: the old rows
 * disappear and the new ones appear together, never half-way.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../db";
import { arClass, arStudents } from "../lib/arabic";
import {
  badRequest,
  conflict,
  isUniqueError,
  notFound,
  parseBody,
  queryBool,
  queryString,
  zTime,
} from "../lib/validate";
import { arTime } from "../messaging/template";
import { emitChange } from "../realtime";
import { logAudit } from "../services/audit.service";

const router = Router();

// ──────────────────────────── Validation ───────────────────────────────

const slotSchema = z
  .object({
    weekday: z.coerce
      .number({ invalid_type_error: "اليوم يجب أن يكون رقماً" })
      .int()
      .min(0, "اليوم يجب أن يكون بين ٠ و ٦")
      .max(6, "اليوم يجب أن يكون بين ٠ و ٦"),
    startTime: zTime,
    endTime: zTime,
    location: z.string().trim().max(120).nullish(),
  })
  .refine((s) => s.startTime < s.endTime, {
    message: "وقت النهاية يجب أن يكون بعد وقت البداية",
    path: ["endTime"],
  });

const createSchema = z.object({
  name: z.string().trim().min(2, "اسم المجموعة مطلوب").max(120),
  subject: z.string().trim().min(1, "المادة مطلوبة").max(80),
  gradeLevel: z.string().trim().min(1, "الصف الدراسي مطلوب").max(80),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "اللون يجب أن يكون بصيغة #RRGGBB")
    .optional(),
  isActive: z.boolean().optional(),
  slots: z.array(slotSchema).max(21, "عدد المواعيد الأسبوعية كبير جداً").optional(),
});

const updateSchema = createSchema.partial();

const enrolSchema = z.object({
  studentIds: z.array(z.string().trim().min(1)),
});

type SlotInput = z.infer<typeof slotSchema>;

/** The DB enforces one slot per (class, weekday, startTime) — collapse repeats. */
function dedupeSlots(slots: SlotInput[]): SlotInput[] {
  const map = new Map<string, SlotInput>();
  for (const s of slots) map.set(`${s.weekday}|${s.startTime}`, s);
  return [...map.values()];
}

const slotOrder: Prisma.ScheduleSlotOrderByWithRelationInput[] = [
  { weekday: "asc" },
  { startTime: "asc" },
];

const withSlots = { slots: { orderBy: slotOrder } } satisfies Prisma.ClassGroupInclude;

type ClassRow = Prisma.ClassGroupGetPayload<{ include: typeof withSlots }>;

const toClassDto = (row: ClassRow, studentCount: number) => ({ ...row, studentCount });

async function countStudents(classGroupId: string): Promise<number> {
  return prisma.enrollment.count({
    where: { classGroupId, isActive: true, student: { isActive: true } },
  });
}

// ─────────────────────── Arabic audit sentences ────────────────────────

/** Index 0 = Sunday, matching `ScheduleSlot.weekday`. */
const WEEKDAYS_AR = [
  "الأحد",
  "الاثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];

type SlotLike = { weekday: number; startTime: string; endTime: string; location?: string | null };

/** "السبت ٤:٠٠ م" */
const slotAr = (s: SlotLike): string =>
  `${WEEKDAYS_AR[s.weekday] ?? ""} ${arTime(s.startTime)}`.trim();

/** Identity of a slot for change detection — the whole row, not just the key. */
const slotKey = (s: SlotLike): string =>
  `${s.weekday}|${s.startTime}|${s.endTime}|${s.location ?? ""}`;

const sameSlots = (a: SlotLike[], b: SlotLike[]): boolean =>
  a.length === b.length &&
  [...a].map(slotKey).sort().join("§") === [...b].map(slotKey).sort().join("§");

/** Up to three students by name; beyond that a count reads better. */
const namesAr = (names: string[]): string =>
  names.length <= 3 ? names.map((n) => `"${n}"`).join(" و") : arStudents(names.length);

/** One sentence per field that genuinely moved. */
function describeClassChange(before: ClassRow, after: ClassRow): string[] {
  const label = arClass(after.name);
  const parts: string[] = [];

  if (before.name !== after.name) {
    parts.push(`غيّر اسم المجموعة من "${before.name}" إلى "${after.name}"`);
  }
  if (before.subject !== after.subject) {
    parts.push(`غيّر مادة ${label} من ${before.subject} إلى ${after.subject}`);
  }
  if (before.gradeLevel !== after.gradeLevel) {
    parts.push(`غيّر صف ${label} من ${before.gradeLevel} إلى ${after.gradeLevel}`);
  }
  if (before.color !== after.color) {
    parts.push(`غيّر لون ${label}`);
  }
  if (before.isActive !== after.isActive) {
    parts.push(after.isActive ? `أعاد تفعيل ${label}` : `أرشف ${label}`);
  }
  if (!sameSlots(before.slots, after.slots)) {
    parts.push(
      after.slots.length === 0
        ? `مسح المواعيد الأسبوعية لـ${label}`
        : `عدّل مواعيد ${label} إلى ${after.slots.map(slotAr).join(" و")}`,
    );
  }

  return parts;
}

const classSnapshot = (row: ClassRow): Record<string, unknown> => ({
  name: row.name,
  subject: row.subject,
  gradeLevel: row.gradeLevel,
  color: row.color,
  isActive: row.isActive,
  slots: row.slots.map(slotKey),
});

// ─────────────────────────────── List ──────────────────────────────────

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const active = queryBool(req, "active");
    const q = queryString(req, "q")?.trim();

    const where: Prisma.ClassGroupWhereInput = {};
    if (active !== undefined) where.isActive = active;
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { subject: { contains: q } },
        { gradeLevel: { contains: q } },
      ];
    }

    const [classes, counts] = await Promise.all([
      prisma.classGroup.findMany({ where, include: withSlots }),
      prisma.enrollment.groupBy({
        by: ["classGroupId"],
        where: { isActive: true, student: { isActive: true } },
        _count: { _all: true },
      }),
    ]);

    const countBy = new Map(counts.map((c) => [c.classGroupId, c._count._all]));

    classes.sort(
      (a, b) =>
        Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name, "ar"),
    );

    res.json(classes.map((c) => toClassDto(c, countBy.get(c.id) ?? 0)));
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────── Detail ─────────────────────────────────

router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const classGroup = await prisma.classGroup.findUnique({
      where: { id },
      include: withSlots,
    });
    if (!classGroup) throw notFound("المجموعة غير موجودة");

    const enrollments = await prisma.enrollment.findMany({
      where: { classGroupId: id, isActive: true, student: { isActive: true } },
      include: { student: true },
    });
    const students = enrollments
      .map((e) => e.student)
      .sort((a, b) => a.name.localeCompare(b.name, "ar"));

    res.json({ ...toClassDto(classGroup, students.length), students });
  } catch (err) {
    next(err);
  }
});

/** The enrolled roster on its own — handy for the enrolment checkbox list. */
router.get("/:id/students", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const exists = await prisma.classGroup.count({ where: { id } });
    if (exists === 0) throw notFound("المجموعة غير موجودة");

    const enrollments = await prisma.enrollment.findMany({
      where: { classGroupId: id, isActive: true, student: { isActive: true } },
      include: { student: true },
    });

    res.json(
      enrollments
        .map((e) => e.student)
        .sort((a, b) => a.name.localeCompare(b.name, "ar")),
    );
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────── Create ─────────────────────────────────

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = parseBody(createSchema, req);
    const slots = dedupeSlots(body.slots ?? []);

    const created = await prisma.$transaction(async (tx) => {
      const classGroup = await tx.classGroup.create({
        data: {
          name: body.name,
          subject: body.subject,
          gradeLevel: body.gradeLevel,
          color: body.color ?? "#2563eb",
          isActive: body.isActive ?? true,
        },
      });

      for (const s of slots) {
        await tx.scheduleSlot.create({
          data: {
            classGroupId: classGroup.id,
            weekday: s.weekday,
            startTime: s.startTime,
            endTime: s.endTime,
            location: s.location ?? null,
          },
        });
      }

      return tx.classGroup.findUniqueOrThrow({
        where: { id: classGroup.id },
        include: withSlots,
      });
    });

    await logAudit(req, {
      action: "CREATE",
      entity: "ClassGroup",
      entityId: created.id,
      summary: created.slots.length
        ? `أنشأ ${arClass(created.name)} لمادة ${created.subject}، مواعيدها ${created.slots.map(slotAr).join(" و")}`
        : `أنشأ ${arClass(created.name)} لمادة ${created.subject}`,
      after: classSnapshot(created),
    });
    emitChange("ClassGroup");

    res.status(201).json(toClassDto(created, 0));
  } catch (err) {
    if (isUniqueError(err)) return next(conflict("يوجد مجموعة أخرى بنفس الاسم"));
    next(err);
  }
});

// ────────────────────────────── Update ─────────────────────────────────

router.patch("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const body = parseBody(updateSchema, req);

    // Slots included: replacing the timetable must be describable afterwards.
    const existing = await prisma.classGroup.findUnique({ where: { id }, include: withSlots });
    if (!existing) throw notFound("المجموعة غير موجودة");

    const data: Prisma.ClassGroupUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.subject !== undefined) data.subject = body.subject;
    if (body.gradeLevel !== undefined) data.gradeLevel = body.gradeLevel;
    if (body.color !== undefined) data.color = body.color;
    if (body.isActive !== undefined) data.isActive = body.isActive;

    const updated = await prisma.$transaction(async (tx) => {
      await tx.classGroup.update({ where: { id }, data });

      // A provided `slots` array replaces the whole weekly timetable.
      if (body.slots !== undefined) {
        await tx.scheduleSlot.deleteMany({ where: { classGroupId: id } });
        for (const s of dedupeSlots(body.slots)) {
          await tx.scheduleSlot.create({
            data: {
              classGroupId: id,
              weekday: s.weekday,
              startTime: s.startTime,
              endTime: s.endTime,
              location: s.location ?? null,
            },
          });
        }
      }

      return tx.classGroup.findUniqueOrThrow({ where: { id }, include: withSlots });
    });

    const changes = describeClassChange(existing, updated);
    if (changes.length > 0) {
      await logAudit(req, {
        action: "UPDATE",
        entity: "ClassGroup",
        entityId: id,
        summary: changes.join("، "),
        before: classSnapshot(existing),
        after: classSnapshot(updated),
      });
      emitChange("ClassGroup");
    }

    res.json(toClassDto(updated, await countStudents(id)));
  } catch (err) {
    if (isUniqueError(err)) return next(conflict("يوجد مجموعة أخرى بنفس الاسم"));
    next(err);
  }
});

// ────────────────────────────── Delete ─────────────────────────────────

/** Soft by default — deleting a class would cascade away its whole history. */
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const hard = queryBool(req, "hard") === true;

    const existing = await prisma.classGroup.findUnique({ where: { id }, include: withSlots });
    if (!existing) throw notFound("المجموعة غير موجودة");

    if (hard) {
      await prisma.classGroup.delete({ where: { id } });

      await logAudit(req, {
        action: "DELETE",
        entity: "ClassGroup",
        entityId: id,
        summary: `حذف ${arClass(existing.name)} نهائياً مع كل حصصها ودرجاتها`,
        before: classSnapshot(existing),
      });
      emitChange("ClassGroup");

      return res.json({ ok: true, hard: true });
    }

    const classGroup = await prisma.classGroup.update({
      where: { id },
      data: { isActive: false },
      include: withSlots,
    });

    if (existing.isActive) {
      await logAudit(req, {
        action: "DELETE",
        entity: "ClassGroup",
        entityId: id,
        summary: `حذف ${arClass(existing.name)}`,
        before: classSnapshot(existing),
        after: classSnapshot(classGroup),
      });
      emitChange("ClassGroup");
    }

    res.json({ ok: true, hard: false, classGroup: toClassDto(classGroup, 0) });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────── Enrolment ───────────────────────────────

/** Replaces the enrolment set with exactly `studentIds`. */
router.post("/:id/students", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { studentIds } = parseBody(enrolSchema, req);
    const keep = [...new Set(studentIds)];

    const classGroup = await prisma.classGroup.findUnique({ where: { id } });
    if (!classGroup) throw notFound("المجموعة غير موجودة");

    const chosen = keep.length
      ? await prisma.student.findMany({ where: { id: { in: keep } }, select: { id: true, name: true } })
      : [];
    if (chosen.length !== keep.length) throw badRequest("أحد الطلاب المختارين غير موجود");

    // Who is in the group *before* the swap — the audit line names the students
    // that actually joined or left, not the whole roster.
    const enrolled = await prisma.enrollment.findMany({
      where: { classGroupId: id, isActive: true },
      include: { student: { select: { id: true, name: true } } },
    });
    const wasIn = new Map(enrolled.map((e) => [e.studentId, e.student.name]));

    const removed = await prisma.$transaction(async (tx) => {
      // Deactivate rather than delete: keeps joinedAt history for re-enrolment.
      const off = await tx.enrollment.updateMany({
        where: keep.length
          ? { classGroupId: id, studentId: { notIn: keep }, isActive: true }
          : { classGroupId: id, isActive: true },
        data: { isActive: false },
      });

      for (const studentId of keep) {
        await tx.enrollment.upsert({
          where: { studentId_classGroupId: { studentId, classGroupId: id } },
          create: { studentId, classGroupId: id, isActive: true },
          update: { isActive: true },
        });
      }

      return off.count;
    });

    const label = arClass(classGroup.name);
    const joined = chosen.filter((s) => !wasIn.has(s.id)).map((s) => s.name);
    const left = [...wasIn.entries()].filter(([sid]) => !keep.includes(sid)).map(([, n]) => n);

    const parts: string[] = [];
    if (joined.length > 0) parts.push(`سجّل ${namesAr(joined)} في ${label}`);
    if (left.length > 0) parts.push(`أزال ${namesAr(left)} من ${label}`);

    if (parts.length > 0) {
      await logAudit(req, {
        action: "UPDATE",
        entity: "ClassGroup",
        entityId: id,
        summary: parts.join("، "),
        before: { students: [...wasIn.values()] },
        after: { students: chosen.map((s) => s.name) },
      });
      // Both sides of the relation moved: the class roster and the students'
      // class chips.
      emitChange("ClassGroup");
      emitChange("Student");
    }

    res.json({ ok: true, enrolled: keep.length, removed });
  } catch (err) {
    next(err);
  }
});

/** Unenrol specific students without touching the rest of the group. */
router.delete("/:id/students", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { studentIds } = parseBody(enrolSchema, req);
    const ids = [...new Set(studentIds)];

    const classGroup = await prisma.classGroup.findUnique({ where: { id } });
    if (!classGroup) throw notFound("المجموعة غير موجودة");
    if (ids.length === 0) return res.json({ ok: true, removed: 0 });

    // Only those still enrolled are really leaving — the rest are a no-op.
    const leaving = await prisma.enrollment.findMany({
      where: { classGroupId: id, studentId: { in: ids }, isActive: true },
      include: { student: { select: { name: true } } },
    });

    const removed = await prisma.enrollment.updateMany({
      where: { classGroupId: id, studentId: { in: ids } },
      data: { isActive: false },
    });

    if (leaving.length > 0) {
      const names = leaving.map((e) => e.student.name);
      await logAudit(req, {
        action: "UPDATE",
        entity: "ClassGroup",
        entityId: id,
        summary: `أزال ${namesAr(names)} من ${arClass(classGroup.name)}`,
        before: { students: names },
      });
      emitChange("ClassGroup");
      emitChange("Student");
    }

    res.json({ ok: true, removed: removed.count });
  } catch (err) {
    next(err);
  }
});

export default router;
