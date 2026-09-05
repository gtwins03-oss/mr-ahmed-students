/**
 * /api/audit — «سجل النشاط». **OWNER only.**
 *
 * Read-only by design: there is no POST, PATCH or DELETE here, and there never
 * should be. A log the owner can edit is not a log. Entries are written from
 * `services/audit.service.ts` as a side effect of the action they describe.
 *
 * The router guards itself (see middleware/auth.ts), so an assistant probing
 * `/api/audit/<id>` gets exactly the same 403 whether that id exists or not.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";

import { notFound, parseQuery, zId, zIsoDate } from "../lib/validate";
import { requireAuth, requireOwner } from "../middleware/auth";
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  AUDIT_LIMIT_DEFAULT,
  AUDIT_LIMIT_MAX,
  actionLabel,
  auditFilterOptions,
  entityLabel,
  getAuditEntry,
  isCalendarDate,
  listAudit,
} from "../services/audit.service";

const router = Router();

router.use(requireAuth, requireOwner);

// ───────────────────────────────── Validation ──────────────────────────────

/**
 * `zIsoDate` validates the *shape* only, so "2026-13-99" passes it. A real
 * calendar check on top turns that into a 400 instead of an Invalid Date
 * reaching Prisma.
 */
const zDay = zIsoDate.refine(isCalendarDate, "التاريخ غير صحيح");

/** Query values arrive as strings, so numbers are coerced and blanks dropped. */
const listQuerySchema = z
  .object({
    userId: zId.optional(),
    action: z.string().trim().max(40).optional(),
    entity: z.string().trim().max(40).optional(),
    entityId: zId.optional(),
    from: zDay.optional(),
    to: zDay.optional(),
    q: z.string().trim().max(120).optional(),
    cursor: zId.optional(),
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(AUDIT_LIMIT_MAX).optional(),
  })
  .partial()
  .strip();

/** `?action=` arriving empty means "no filter", not "filter on empty string". */
const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

// ─────────────────────────────────── List ──────────────────────────────────

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = parseQuery(listQuerySchema, req);

    const page = await listAudit({
      userId: clean(query.userId),
      action: clean(query.action)?.toUpperCase(),
      entity: clean(query.entity),
      entityId: clean(query.entityId),
      from: query.from,
      to: query.to,
      q: clean(query.q),
      cursor: clean(query.cursor),
      offset: query.offset,
      limit: query.limit ?? AUDIT_LIMIT_DEFAULT,
    });

    res.json(page);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────── Dropdown contents ────────────────────────────

/**
 * Declared before `/:id` — Express matches in order, and "filters" is a
 * perfectly valid cuid-shaped path segment as far as the router is concerned.
 *
 * `actions` / `entities` list what is really in the log; `allActions` /
 * `allEntities` list the full vocabulary, so a fresh install still renders a
 * usable filter bar.
 */
router.get("/filters", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const options = await auditFilterOptions();

    res.json({
      ...options,
      allActions: AUDIT_ACTIONS.map((value) => ({ value, label: actionLabel(value) })),
      allEntities: AUDIT_ENTITIES.map((value) => ({ value, label: entityLabel(value) })),
    });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────── Detail ─────────────────────────────────

/** One entry, with the complete before/after JSON already parsed. */
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entry = await getAuditEntry(req.params.id);
    if (!entry) throw notFound("هذا السجل غير موجود");

    res.json(entry);
  } catch (err) {
    next(err);
  }
});

export default router;
