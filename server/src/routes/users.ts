/**
 * /api/users — account management. **OWNER only.**
 *
 * Assistants must not learn that this endpoint exists: the guard sits on the
 * router itself, so every path below answers an identical 403 without touching
 * the database (see middleware/auth.ts). The web app hides the nav item too —
 * that is cosmetic; this is the real boundary.
 *
 * `passwordHash` never leaves this file: every read goes through `userSelect`,
 * which simply does not list the column.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { Prisma, type User } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../db";
import {
  badRequest,
  conflict,
  isUniqueError,
  notFound,
  parseBody,
  queryBool,
  queryString,
} from "../lib/validate";
import { requireAuth, requireOwner } from "../middleware/auth";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  ROLES,
  hashPassword,
  roleLabel,
} from "../services/auth.service";
import { logAudit } from "../services/audit.service";

const router = Router();

// Self-guarding: correct even if the mount point forgets to add the middleware.
router.use(requireAuth, requireOwner);

// ───────────────────────────────── Messages ────────────────────────────────

const USERNAME_TAKEN = "اسم المستخدم مستخدم بالفعل، اختر اسماً آخر";
const LAST_OWNER = "يجب أن يبقى صاحب حساب واحد نشط على الأقل";
const NO_SELF_DELETE = "لا يمكنك حذف حسابك الخاص";
const NO_SELF_DEACTIVATE = "لا يمكنك إيقاف حسابك الخاص";
const NO_SELF_ROLE_CHANGE = "لا يمكنك تغيير صلاحية حسابك الخاص";

// ─────────────────────────────────── Shape ─────────────────────────────────

/** The only columns that ever reach the client — note the missing hash. */
const userSelect = {
  id: true,
  name: true,
  username: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

const toUserDto = (user: UserRow) => ({ ...user, roleLabel: roleLabel(user.role) });

/** The audit snapshot: identical to the DTO, minus the derived label. */
const toSnapshot = (user: Pick<User, "name" | "username" | "role" | "isActive">) => ({
  name: user.name,
  username: user.username,
  role: user.role,
  isActive: user.isActive,
});

// ───────────────────────────────── Validation ──────────────────────────────

const nameSchema = z.string().trim().min(2, "اسم المستخدم الكامل مطلوب").max(120);

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9._-]{3,32}$/,
    "اسم الدخول: من ٣ إلى ٣٢ حرفاً إنجليزياً أو رقماً (النقطة والشرطة مسموحتان)",
  );

const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `كلمة المرور يجب ألا تقل عن ${PASSWORD_MIN_LENGTH} أحرف`)
  .max(PASSWORD_MAX_LENGTH, "كلمة المرور طويلة جداً");

const roleSchema = z.enum(ROLES, {
  errorMap: () => ({ message: "الصلاحية يجب أن تكون OWNER أو ASSISTANT" }),
});

const createSchema = z.object({
  name: nameSchema,
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema.default("ASSISTANT"),
  isActive: z.boolean().optional(),
});

const updateSchema = z
  .object({
    name: nameSchema,
    username: usernameSchema,
    role: roleSchema,
    isActive: z.boolean(),
  })
  .partial();

/** Accepts `{ password }` or `{ newPassword }` — both spellings are in use. */
const resetPasswordSchema = z
  .object({
    password: passwordSchema.optional(),
    newPassword: passwordSchema.optional(),
  })
  .transform((value, ctx): { password: string } => {
    const password = value.password ?? value.newPassword;
    if (!password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "كلمة المرور الجديدة مطلوبة",
      });
      return z.NEVER;
    }
    return { password };
  });

// ───────────────────────────────── Guards ──────────────────────────────────

async function findUserOr404(id: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw notFound("المستخدم غير موجود");
  return user;
}

/**
 * Refuses any change that would leave the system with no active OWNER — which
 * would lock everyone out of user management and the audit log permanently,
 * with no way back except editing the database by hand.
 *
 * `next` is null for a deletion.
 */
async function assertActiveOwnerRemains(
  target: User,
  next: { role?: string; isActive?: boolean } | null,
): Promise<void> {
  // Only an active owner can be the *last* active owner.
  if (target.role !== "OWNER" || !target.isActive) return;

  const stillActiveOwner =
    next !== null && (next.role ?? target.role) === "OWNER" && (next.isActive ?? true);
  if (stillActiveOwner) return;

  const others = await prisma.user.count({
    where: { role: "OWNER", isActive: true, id: { not: target.id } },
  });
  if (others === 0) throw conflict(LAST_OWNER);
}

// ─────────────────────────────────── List ──────────────────────────────────

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = queryString(req, "q")?.trim();
    const active = queryBool(req, "active");

    const where: Prisma.UserWhereInput = {};
    if (active !== undefined) where.isActive = active;
    if (q) where.OR = [{ name: { contains: q } }, { username: { contains: q } }];

    const users = await prisma.user.findMany({ where, select: userSelect });

    // Owners first, then alphabetically — the roster is small enough to sort here.
    users.sort(
      (a, b) =>
        Number(b.isActive) - Number(a.isActive) ||
        Number(b.role === "OWNER") - Number(a.role === "OWNER") ||
        a.name.localeCompare(b.name, "ar"),
    );

    res.json(users.map(toUserDto));
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────── Detail ─────────────────────────────────

router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: userSelect,
    });
    if (!user) throw notFound("المستخدم غير موجود");

    res.json(toUserDto(user));
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────── Create ─────────────────────────────────

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = parseBody(createSchema, req);

    const created = await prisma.user.create({
      data: {
        name: body.name,
        username: body.username,
        passwordHash: await hashPassword(body.password),
        role: body.role,
        isActive: body.isActive ?? true,
      },
      select: userSelect,
    });

    await logAudit(req, {
      action: "CREATE",
      entity: "User",
      entityId: created.id,
      summary: `أضاف المستخدم «${created.name}» (${created.username}) بصلاحية ${roleLabel(created.role)}`,
      after: toSnapshot(created),
    });

    res.status(201).json(toUserDto(created));
  } catch (err) {
    if (isUniqueError(err)) return next(conflict(USERNAME_TAKEN));
    next(err);
  }
});

// ────────────────────────────────── Update ─────────────────────────────────

router.patch("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const body = parseBody(updateSchema, req);
    const actor = req.user;

    const existing = await findUserOr404(id);
    const isSelf = actor?.id === existing.id;

    if (isSelf && body.isActive === false) throw badRequest(NO_SELF_DEACTIVATE);
    if (isSelf && body.role !== undefined && body.role !== existing.role) {
      throw badRequest(NO_SELF_ROLE_CHANGE);
    }

    await assertActiveOwnerRemains(existing, { role: body.role, isActive: body.isActive });

    const data: Prisma.UserUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.username !== undefined) data.username = body.username;
    if (body.role !== undefined) data.role = body.role;
    if (body.isActive !== undefined) data.isActive = body.isActive;

    const updated = await prisma.user.update({ where: { id }, data, select: userSelect });

    await logAudit(req, {
      action: "UPDATE",
      entity: "User",
      entityId: id,
      summary: describeUserUpdate(existing, updated),
      before: toSnapshot(existing),
      after: toSnapshot(updated),
    });

    res.json(toUserDto(updated));
  } catch (err) {
    if (isUniqueError(err)) return next(conflict(USERNAME_TAKEN));
    next(err);
  }
});

/** "أوقف المستخدم «سارة»" reads better in the log than a generic "عدّل". */
function describeUserUpdate(before: User, after: UserRow): string {
  const changes: string[] = [];

  if (before.name !== after.name) changes.push(`الاسم إلى «${after.name}»`);
  if (before.username !== after.username) changes.push(`اسم الدخول إلى «${after.username}»`);
  if (before.role !== after.role) changes.push(`الصلاحية إلى ${roleLabel(after.role)}`);
  if (before.isActive !== after.isActive) {
    changes.push(after.isActive ? "وأعاد تفعيل الحساب" : "وأوقف الحساب");
  }

  if (changes.length === 0) return `حفظ بيانات المستخدم «${after.name}» دون تغيير`;
  return `عدّل المستخدم «${before.name}»: ${changes.join(" ، ")}`;
}

// ────────────────────────────── Password reset ─────────────────────────────

/**
 * The owner setting somebody else's password — no current password required,
 * unlike /api/auth/change-password. The new value is never logged.
 */
router.post("/:id/password", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { password } = parseBody(resetPasswordSchema, req);

    const existing = await findUserOr404(id);

    await prisma.user.update({
      where: { id },
      data: { passwordHash: await hashPassword(password) },
    });

    await logAudit(req, {
      action: "UPDATE",
      entity: "User",
      entityId: id,
      summary:
        req.user?.id === id
          ? `أعاد تعيين كلمة المرور الخاصة به`
          : `أعاد تعيين كلمة مرور المستخدم «${existing.name}»`,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────── Delete ─────────────────────────────────

/**
 * A hard delete. `AuditLog.userId` is `onDelete: SetNull`, so the account's
 * history survives it — every row keeps the `userName` snapshot it was written
 * with.
 */
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const existing = await findUserOr404(id);
    if (req.user?.id === existing.id) throw badRequest(NO_SELF_DELETE);

    await assertActiveOwnerRemains(existing, null);

    await prisma.user.delete({ where: { id } });

    await logAudit(req, {
      action: "DELETE",
      entity: "User",
      entityId: id,
      summary: `حذف المستخدم «${existing.name}» (${existing.username})`,
      before: toSnapshot(existing),
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
