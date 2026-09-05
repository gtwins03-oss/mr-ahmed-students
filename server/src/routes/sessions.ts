/**
 * /api/sessions — the attendance board's data source.
 *
 * `POST /ensure` materialises the day's sessions from the weekly schedule and is
 * safe to call on every page load; `POST /:id/attendance` is the bulk upsert
 * that also queues absence / late alerts.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";

import { prisma } from "../db";
import { arClass, arSessions } from "../lib/arabic";
import {
  badRequest,
  notFound,
  parseBody,
  parseValue,
  queryString,
  zId,
  zIsoDate,
  zTime,
} from "../lib/validate";
import { arDate, arTime } from "../messaging/template";
import { emitChange } from "../realtime";
import { saveAttendance } from "../services/attendance.service";
import { logAudit } from "../services/audit.service";
import {
  ensureSessions,
  getSessionById,
  getSessionsForDate,
  todayISO,
} from "../services/sessions.service";

const router = Router();

/** Session status in Arabic — mirrors SESSION_STATUS_AR on the web side. */
const SESSION_STATUS_AR: Record<string, string> = {
  PLANNED: "مجدولة",
  HELD: "منعقدة",
  CANCELLED: "ملغاة",
};

const statusAr = (status: string): string => SESSION_STATUS_AR[status] ?? status;

// ──────────────────────────── Validation ───────────────────────────────

const attendanceSchema = z.object({
  marks: z
    .array(
      z.object({
        studentId: zId,
        status: z.enum(["PRESENT", "ABSENT", "LATE", "EXCUSED"], {
          errorMap: () => ({ message: "حالة الحضور غير معروفة" }),
        }),
        minutesLate: z.coerce
          .number()
          .int("عدد دقائق التأخير يجب أن يكون رقماً صحيحاً")
          .min(0, "عدد دقائق التأخير لا يمكن أن يكون سالباً")
          .max(600, "عدد دقائق التأخير كبير جداً")
          .nullish(),
        note: z.string().trim().max(500).nullish(),
      }),
    )
    .max(300, "عدد الطلاب في الطلب كبير جداً"),
});

const createSchema = z.object({
  classGroupId: zId,
  date: zIsoDate,
  startTime: zTime,
  endTime: zTime.nullish(),
  topic: z.string().trim().max(200).nullish(),
  status: z.enum(["PLANNED", "HELD", "CANCELLED"]).optional(),
});

const updateSchema = z.object({
  startTime: zTime.optional(),
  endTime: zTime.nullish(),
  topic: z.string().trim().max(200).nullish(),
  status: z.enum(["PLANNED", "HELD", "CANCELLED"]).optional(),
});

/** `?date=` — defaults to today in the server's local timezone. */
function readDate(req: Request): string {
  const raw = queryString(req, "date");
  if (!raw) return todayISO();
  return parseValue(zIsoDate, raw);
}

// ───────────────────────── Materialise the day ─────────────────────────

router.post("/ensure", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const date = readDate(req);
    const created = await ensureSessions(date);

    // The board calls this on every page load; only a real materialisation is
    // worth a line in the history.
    if (created > 0) {
      await logAudit(req, {
        action: "CREATE",
        entity: "Session",
        entityId: null,
        summary: `أنشأ ${arSessions(created)} ليوم ${arDate(date)} من الجدول الأسبوعي`,
        after: { date, created },
      });
      emitChange("Session");
    }

    res.json({ created });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────── Day view ───────────────────────────────

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const date = readDate(req);
    const classId = queryString(req, "classId");
    res.json(await getSessionsForDate(date, classId));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await getSessionById(req.params.id);
    if (!session) throw notFound("الحصة غير موجودة");
    res.json(session);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/roster", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await getSessionById(req.params.id);
    if (!session) throw notFound("الحصة غير موجودة");
    res.json(session);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────── Attendance ───────────────────────────────

router.post("/:id/attendance", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { marks } = parseBody(attendanceSchema, req);

    // The service owns the audit lines: it is the only place that knows which
    // students actually changed.
    const result = await saveAttendance(
      req.params.id,
      marks.map((m) => ({
        studentId: m.studentId,
        status: m.status,
        minutesLate: m.minutesLate ?? null,
        note: m.note ?? null,
      })),
      req,
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─────────────────── Ad-hoc sessions (make-up classes) ─────────────────

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = parseBody(createSchema, req);

    const classGroup = await prisma.classGroup.findUnique({
      where: { id: body.classGroupId },
    });
    if (!classGroup) throw badRequest("المجموعة غير موجودة");

    const slot = {
      classGroupId: body.classGroupId,
      date: body.date,
      startTime: body.startTime,
    };

    // Upsert cannot tell us afterwards whether it created or updated, and
    // «أضاف حصة» must not be logged for an edit.
    const existing = await prisma.session.findUnique({
      where: { classGroupId_date_startTime: slot },
    });

    const session = await prisma.session.upsert({
      where: { classGroupId_date_startTime: slot },
      update: {
        endTime: body.endTime ?? null,
        topic: body.topic ?? null,
        ...(body.status ? { status: body.status } : {}),
      },
      create: {
        classGroupId: body.classGroupId,
        date: body.date,
        startTime: body.startTime,
        endTime: body.endTime ?? null,
        topic: body.topic ?? null,
        status: body.status ?? "HELD",
      },
    });

    // Re-posting an identical session (the board does this freely) is not news.
    const unchanged =
      existing !== null &&
      (existing.endTime ?? null) === (session.endTime ?? null) &&
      (existing.topic ?? null) === (session.topic ?? null) &&
      existing.status === session.status;

    if (!unchanged) {
      const label = arClass(classGroup.name);
      const when = `يوم ${arDate(session.date)} الساعة ${arTime(session.startTime)}`;

      await logAudit(req, {
        action: existing ? "UPDATE" : "CREATE",
        entity: "Session",
        entityId: session.id,
        summary: existing ? `عدّل حصة ل${label} ${when}` : `أضاف حصة ل${label} ${when}`,
        before: existing
          ? { endTime: existing.endTime, topic: existing.topic, status: existing.status }
          : null,
        after: {
          date: session.date,
          startTime: session.startTime,
          endTime: session.endTime,
          topic: session.topic,
          status: session.status,
        },
      });
      emitChange("Session");
    }

    const view = await getSessionById(session.id);
    res.status(201).json(view);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const body = parseBody(updateSchema, req);

    const existing = await prisma.session.findUnique({
      where: { id },
      include: { classGroup: true },
    });
    if (!existing) throw notFound("الحصة غير موجودة");

    const updated = await prisma.session.update({
      where: { id },
      data: {
        ...(body.startTime !== undefined ? { startTime: body.startTime } : {}),
        ...(body.endTime !== undefined ? { endTime: body.endTime } : {}),
        ...(body.topic !== undefined ? { topic: body.topic } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
    });

    const label = arClass(existing.classGroup.name);
    const day = arDate(existing.date);
    const changes: string[] = [];

    if (existing.startTime !== updated.startTime) {
      changes.push(
        `غيّر موعد حصة ${label} يوم ${day} من ${arTime(existing.startTime)} إلى ${arTime(updated.startTime)}`,
      );
    }
    if ((existing.endTime ?? "") !== (updated.endTime ?? "")) {
      changes.push(
        updated.endTime
          ? `غيّر نهاية حصة ${label} يوم ${day} إلى ${arTime(updated.endTime)}`
          : `مسح وقت نهاية حصة ${label} يوم ${day}`,
      );
    }
    if ((existing.topic ?? "") !== (updated.topic ?? "")) {
      changes.push(
        updated.topic
          ? `حدّد موضوع حصة ${label} يوم ${day}: "${updated.topic}"`
          : `مسح موضوع حصة ${label} يوم ${day}`,
      );
    }
    if (existing.status !== updated.status) {
      changes.push(
        `غيّر حالة حصة ${label} يوم ${day} من ${statusAr(existing.status)} إلى ${statusAr(updated.status)}`,
      );
    }

    if (changes.length > 0) {
      await logAudit(req, {
        action: "UPDATE",
        entity: "Session",
        entityId: id,
        summary: changes.join("، "),
        before: {
          startTime: existing.startTime,
          endTime: existing.endTime,
          topic: existing.topic,
          status: existing.status,
        },
        after: {
          startTime: updated.startTime,
          endTime: updated.endTime,
          topic: updated.topic,
          status: updated.status,
        },
      });
      emitChange("Session");
    }

    res.json(await getSessionById(id));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const existing = await prisma.session.findUnique({
      where: { id },
      include: { classGroup: true, attendance: { select: { id: true } } },
    });
    if (!existing) throw notFound("الحصة غير موجودة");

    await prisma.session.delete({ where: { id } });

    const label = arClass(existing.classGroup.name);
    await logAudit(req, {
      action: "DELETE",
      entity: "Session",
      entityId: id,
      summary: existing.attendance.length
        ? `حذف حصة ${label} يوم ${arDate(existing.date)} مع سجل حضورها`
        : `حذف حصة ${label} يوم ${arDate(existing.date)}`,
      before: {
        date: existing.date,
        startTime: existing.startTime,
        endTime: existing.endTime,
        topic: existing.topic,
        status: existing.status,
        attendanceCount: existing.attendance.length,
      },
    });
    emitChange("Session");

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
