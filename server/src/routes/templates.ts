/**
 * /api/templates — the Arabic message templates.
 *
 * The teacher must be able to reword every parent-facing message without a
 * developer, so these rows are fully editable. Unknown {{placeholders}} render
 * as empty strings rather than throwing (docs/02-messaging.md §2.4).
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { MessageTemplate } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../db";
import { notFound, parseBody } from "../lib/validate";
import { emitChange } from "../realtime";
import { logAudit } from "../services/audit.service";

const router = Router();

/** Display order in the settings screen; anything else sorts after these. */
const KEY_ORDER = ["ABSENCE", "LATE", "LOW_GRADE", "MONTHLY_REPORT", "CUSTOM"];

/** How the teacher refers to each template — «عدّل قالب رسالة الغياب». */
const TEMPLATE_AR: Record<string, string> = {
  ABSENCE: "رسالة الغياب",
  LATE: "رسالة التأخير",
  LOW_GRADE: "رسالة الدرجة المنخفضة",
  MONTHLY_REPORT: "التقرير الشهري",
  CUSTOM: "الرسالة المخصصة",
};

/** Placeholders the system can actually supply, per template. */
const PLACEHOLDERS: Record<string, string[]> = {
  ABSENCE: ["student_name", "parent_name", "teacher_name", "subject", "class_name", "date_ar", "time_ar"],
  LATE: ["student_name", "parent_name", "teacher_name", "subject", "class_name", "date_ar", "time_ar", "minutes_late"],
  LOW_GRADE: [
    "student_name", "parent_name", "teacher_name", "subject", "class_name",
    "assessment_title", "date_ar", "score", "max_score", "percentage", "threshold",
  ],
  MONTHLY_REPORT: [
    "student_name", "parent_name", "teacher_name", "period_ar", "teacher_note",
    "sessions_total", "present_count", "absent_count", "late_count", "attendance_rate",
    "assessments_count", "average_percentage", "best_percentage", "worst_percentage",
  ],
  CUSTOM: ["student_name", "parent_name", "teacher_name"],
};

const upsertSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2, "مفتاح القالب مطلوب")
    .max(40)
    .regex(/^[A-Z_]+$/, "مفتاح القالب يجب أن يكون بحروف إنجليزية كبيرة"),
  name: z.string().trim().min(1, "اسم القالب مطلوب").max(80).optional(),
  body: z.string().trim().min(5, "نص القالب مطلوب").max(4000, "نص القالب طويل جداً"),
  isActive: z.boolean().optional(),
});

const bodySchema = upsertSchema.omit({ key: true });

const sortTemplates = <T extends { key: string }>(rows: T[]): T[] =>
  rows.sort((a, b) => {
    const ai = KEY_ORDER.indexOf(a.key);
    const bi = KEY_ORDER.indexOf(b.key);
    return (ai === -1 ? KEY_ORDER.length : ai) - (bi === -1 ? KEY_ORDER.length : bi) ||
      a.key.localeCompare(b.key);
  });

// ──────────────────────── Upsert + its audit line ──────────────────────

type TemplatePatch = { name?: string; body: string; isActive?: boolean };

const templateAr = (row: MessageTemplate): string =>
  TEMPLATE_AR[row.key] ?? (row.name ? `"${row.name}"` : row.key);

/** A sentence naming the template, or null when the save changed nothing. */
function describeTemplateChange(
  before: MessageTemplate | null,
  after: MessageTemplate,
): string | null {
  const label = templateAr(after);
  if (!before) return `أضاف قالب ${label}`;

  const parts: string[] = [];
  if (before.body !== after.body) parts.push(`عدّل قالب ${label}`);
  if (before.name !== after.name) {
    parts.push(`غيّر اسم قالب ${label} من "${before.name}" إلى "${after.name}"`);
  }
  if (before.isActive !== after.isActive) {
    parts.push(after.isActive ? `فعّل قالب ${label}` : `أوقف قالب ${label}`);
  }

  return parts.length > 0 ? parts.join("، ") : null;
}

/**
 * Both PUT routes are the same write; the only difference is where the key
 * comes from. Reading the row first is what lets the log say «عدّل» rather than
 * «أضاف» — and say nothing at all when the teacher saved an unchanged form.
 */
async function saveTemplate(
  req: Request,
  key: string,
  patch: TemplatePatch,
): Promise<MessageTemplate> {
  const { name, body, isActive } = patch;

  const before = await prisma.messageTemplate.findUnique({ where: { key } });

  const template = await prisma.messageTemplate.upsert({
    where: { key },
    create: { key, name: name ?? key, body, isActive: isActive ?? true },
    update: {
      body,
      ...(name !== undefined ? { name } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
    },
  });

  const summary = describeTemplateChange(before, template);
  if (summary) {
    await logAudit(req, {
      action: "UPDATE",
      entity: "MessageTemplate",
      entityId: key,
      summary,
      before: before ? { name: before.name, body: before.body, isActive: before.isActive } : null,
      after: { name: template.name, body: template.body, isActive: template.isActive },
    });
    emitChange("MessageTemplate");
  }

  return template;
}

// ─────────────────────────────── Reads ─────────────────────────────────

router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const templates = await prisma.messageTemplate.findMany();
    res.json(sortTemplates(templates));
  } catch (err) {
    next(err);
  }
});

/** The placeholder contract, so the editor can offer/validate the keys. */
router.get("/placeholders", (_req: Request, res: Response) => {
  res.json(PLACEHOLDERS);
});

router.get("/:key", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const template = await prisma.messageTemplate.findUnique({
      where: { key: req.params.key },
    });
    if (!template) throw notFound("القالب غير موجود");
    res.json(template);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────── Writes ────────────────────────────────

router.put("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { key, ...patch } = parseBody(upsertSchema, req);
    res.json(await saveTemplate(req, key, patch));
  } catch (err) {
    next(err);
  }
});

router.put("/:key", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const patch = parseBody(bodySchema, req);
    res.json(await saveTemplate(req, req.params.key, patch));
  } catch (err) {
    next(err);
  }
});

export default router;
