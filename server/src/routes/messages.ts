/**
 * /api/messages — the outbox and its history.
 *
 * Every message carries a ready-made `waLink`: on Tier 0 (WA_LINK) the teacher
 * taps it, WhatsApp opens with the Arabic text already typed, and the UI then
 * calls /mark-sent. On Tier 1/2 the same rows are drained automatically.
 *
 * Rendering and dispatch belong to the messaging layer — these handlers only
 * validate, delegate, and shape the response.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../db";
import { toWaLink } from "../lib/phone";
import { badRequest, notFound, parseBody, queryString, zId } from "../lib/validate";
import { resolveProvider } from "../messaging";
import { renderPreview, sendMessageNow } from "../messaging/outbox";
import { emitChange } from "../realtime";
import { logAudit } from "../services/audit.service";
import { getSettings } from "../services/settings.service";

const router = Router();

const MANUAL_PROVIDER_ERROR = "المزوّد الحالي يتطلب الإرسال اليدوي";

/** What each queued message *is*, in Arabic — matches the seeded template names. */
const TEMPLATE_AR: Record<string, string> = {
  ABSENCE: "تنبيه غياب",
  LATE: "تنبيه تأخير",
  LOW_GRADE: "تنبيه مستوى",
  MONTHLY_REPORT: "التقرير الشهري",
  CUSTOM: "رسالة مخصصة",
};

// ────────────────────────────── The DTO ────────────────────────────────

const withStudent = {
  student: { select: { name: true, parentName: true } },
} satisfies Prisma.MessageInclude;

type MessageRow = Prisma.MessageGetPayload<{ include: typeof withStudent }>;

function toMessageDto(m: MessageRow) {
  return {
    id: m.id,
    studentId: m.studentId,
    studentName: m.student?.name ?? null,
    parentName: m.student?.parentName ?? null,
    toPhone: m.toPhone,
    channel: m.channel,
    templateKey: m.templateKey,
    body: m.body,
    status: m.status,
    error: m.error,
    createdAt: m.createdAt,
    sentAt: m.sentAt,
    waLink: toWaLink(m.toPhone, m.body),
  };
}

async function findMessageOr404(id: string): Promise<MessageRow> {
  const message = await prisma.message.findUnique({ where: { id }, include: withStudent });
  if (!message) throw notFound("الرسالة غير موجودة");
  return message;
}

// ─────────────────────── Arabic audit sentences ────────────────────────

/** "تنبيه غياب" — a message the teacher would recognise, not a template key. */
const kindAr = (m: MessageRow): string => TEMPLATE_AR[m.templateKey ?? ""] ?? "رسالة";

/** «ولي أمر "أحمد سمير"», or the bare number once the student is deleted. */
const recipientAr = (m: MessageRow): string =>
  m.student?.name ? `ولي أمر "${m.student.name}"` : `الرقم ${m.toPhone}`;

// ─────────────────────────────── List ──────────────────────────────────

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const statusRaw = queryString(req, "status");
    const studentId = queryString(req, "studentId");
    const limit = Math.min(Number(queryString(req, "limit") ?? 300) || 300, 1000);

    const where: Prisma.MessageWhereInput = {};
    if (statusRaw && statusRaw.toUpperCase() !== "ALL") {
      const statuses = statusRaw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      if (statuses.length === 1) where.status = statuses[0];
      else if (statuses.length > 1) where.status = { in: statuses };
    }
    if (studentId) where.studentId = studentId;

    const messages = await prisma.message.findMany({
      where,
      include: withStudent,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    res.json(messages.map(toMessageDto));
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────── Preview ─────────────────────────────────

const previewSchema = z.object({
  templateKey: z.string().trim().min(1, "مفتاح القالب مطلوب"),
  studentId: zId.optional(),
});

/** Renders a template without saving anything — the templates editor preview. */
router.post("/preview", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { templateKey, studentId } = parseBody(previewSchema, req);
    res.json({ body: await renderPreview(templateKey, studentId) });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────── Edit before sending ──────────────────────────

const patchSchema = z.object({
  body: z.string().trim().min(1, "نص الرسالة مطلوب").max(4000, "نص الرسالة طويل جداً"),
});

router.patch("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { body } = parseBody(patchSchema, req);

    const message = await findMessageOr404(id);
    if (message.status !== "PENDING") {
      throw badRequest("لا يمكن تعديل رسالة لم تعد في قائمة الانتظار");
    }

    const updated = await prisma.message.update({
      where: { id },
      data: { body },
      include: withStudent,
    });

    if (message.body !== updated.body) {
      await logAudit(req, {
        action: "MESSAGE",
        entity: "Message",
        entityId: id,
        summary: `عدّل نص ${kindAr(updated)} الموجّه إلى ${recipientAr(updated)} قبل الإرسال`,
        before: { body: message.body },
        after: { body: updated.body },
      });
      emitChange("Message");
    }

    res.json(toMessageDto(updated));
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────── Actions ─────────────────────────────────

/** Tier 0: the teacher confirms they actually hit Send inside WhatsApp. */
router.post("/:id/mark-sent", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const message = await findMessageOr404(id);
    const settings = await getSettings();

    const updated = await prisma.message.update({
      where: { id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        provider: settings.provider,
        error: null,
        attempts: { increment: 1 },
      },
      include: withStudent,
    });

    // Confirming an already-sent message is a stray tap, not a second send.
    if (message.status !== "SENT") {
      await logAudit(req, {
        action: "MESSAGE",
        entity: "Message",
        entityId: id,
        summary: `أرسل ${kindAr(updated)} إلى ${recipientAr(updated)}`,
        before: { status: message.status },
        after: { status: updated.status, provider: updated.provider },
      });
      emitChange("Message");
    }

    res.json(toMessageDto(updated));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/skip", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const message = await findMessageOr404(id);

    const updated = await prisma.message.update({
      where: { id },
      data: { status: "SKIPPED", error: null },
      include: withStudent,
    });

    if (message.status !== "SKIPPED") {
      await logAudit(req, {
        action: "MESSAGE",
        entity: "Message",
        entityId: id,
        summary: `تجاهل ${kindAr(updated)} الموجّه إلى ${recipientAr(updated)}`,
        before: { status: message.status },
        after: { status: updated.status },
      });
      emitChange("Message");
    }

    res.json(toMessageDto(updated));
  } catch (err) {
    next(err);
  }
});

/** Puts a FAILED / SKIPPED message back into the queue. */
router.post("/:id/retry", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const message = await findMessageOr404(id);

    const updated = await prisma.message.update({
      where: { id },
      data: { status: "PENDING", error: null, attempts: 0, sentAt: null },
      include: withStudent,
    });

    if (message.status !== "PENDING") {
      await logAudit(req, {
        action: "MESSAGE",
        entity: "Message",
        entityId: id,
        summary: `أعاد ${kindAr(updated)} الموجّه إلى ${recipientAr(updated)} إلى قائمة الإرسال`,
        before: { status: message.status, error: message.error },
        after: { status: updated.status },
      });
      emitChange("Message");
    }

    res.json(toMessageDto(updated));
  } catch (err) {
    next(err);
  }
});

/** Tier 1/2: dispatch through the active provider right now. */
router.post("/:id/send", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const message = await findMessageOr404(id);
    if (message.status === "SENT") return res.json({ ok: true });

    const settings = await getSettings();
    if (!resolveProvider(settings).autonomous) {
      return res.status(400).json({ ok: false, error: MANUAL_PROVIDER_ERROR });
    }

    // The outbox owns attempt counting, retry rules and error truncation.
    const result = await sendMessageNow(id);

    await logAudit(req, {
      action: "MESSAGE",
      entity: "Message",
      entityId: id,
      summary: result.ok
        ? `أرسل ${kindAr(message)} إلى ${recipientAr(message)}`
        : `فشل إرسال ${kindAr(message)} إلى ${recipientAr(message)}: ${result.error ?? "سبب غير معروف"}`,
      before: { status: message.status },
      after: { status: result.ok ? "SENT" : "FAILED", provider: settings.provider },
    });
    emitChange("Message");

    // A provider refusal is a normal outcome, not a server fault: report it in
    // the body so the UI can show the Arabic reason next to the message.
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
