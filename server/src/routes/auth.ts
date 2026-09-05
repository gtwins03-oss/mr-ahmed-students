/**
 * /api/auth — login, "who am I", and self-service password change.
 *
 * This router is **public**: it must be mounted *before* the global
 * `requireAuth`, otherwise nobody could ever reach /login. The two endpoints
 * that do need an identity guard themselves, per-route.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";

import { prisma } from "../db";
import { badRequest, httpError, parseBody } from "../lib/validate";
import { requireAuth } from "../middleware/auth";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  changePassword,
  login,
  roleLabel,
} from "../services/auth.service";
import { clientIp, logAudit } from "../services/audit.service";

const router = Router();

// ───────────────────────── Login rate limiting ─────────────────────────
//
// In-process and deliberately simple: this app is one Node process on the
// teacher's own machine, so a Map is a complete solution — no Redis, no extra
// dependency. Counters reset when the server restarts, which is acceptable for
// a lockout window measured in minutes.

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const TOO_MANY_ATTEMPTS =
  "تجاوزت عدد محاولات تسجيل الدخول المسموح بها. برجاء المحاولة بعد ١٥ دقيقة.";

type Attempt = { count: number; resetAt: number };

const loginAttempts = new Map<string, Attempt>();

/**
 * The *socket* address, never `x-forwarded-for`.
 *
 * Express runs without `trust proxy`, so `req.ip` is the real peer. A
 * client-supplied header would let an attacker rotate the key on every request
 * and walk straight through the limiter.
 */
const limiterKey = (req: Request): string =>
  req.ip || req.socket?.remoteAddress || "unknown";

/** Drops expired counters so the Map cannot grow without bound. */
function pruneAttempts(now: number): void {
  if (loginAttempts.size < 500) return;
  for (const [key, attempt] of loginAttempts) {
    if (attempt.resetAt <= now) loginAttempts.delete(key);
  }
}

/** Registers one attempt and throws 429 once the window's budget is spent. */
function consumeAttempt(req: Request): void {
  const now = Date.now();
  pruneAttempts(now);

  const key = limiterKey(req);
  const current = loginAttempts.get(key);

  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }

  current.count += 1;
  if (current.count > LOGIN_MAX_ATTEMPTS) throw httpError(429, TOO_MANY_ATTEMPTS);
}

/** A correct password clears the counter — typos must not lock out the owner. */
const clearAttempts = (req: Request): void => {
  loginAttempts.delete(limiterKey(req));
};

// ─────────────────────────────── Validation ────────────────────────────────

const loginSchema = z.object({
  username: z.string().trim().min(1, "اسم المستخدم مطلوب").max(64),
  password: z.string().min(1, "كلمة المرور مطلوبة").max(PASSWORD_MAX_LENGTH),
});

const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `كلمة المرور يجب ألا تقل عن ${PASSWORD_MIN_LENGTH} أحرف`)
  .max(PASSWORD_MAX_LENGTH, "كلمة المرور طويلة جداً");

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, "كلمة المرور الحالية مطلوبة").max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});

// ─────────────────────────────────── Login ─────────────────────────────────

router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    consumeAttempt(req);

    const { username, password } = parseBody(loginSchema, req);
    const result = await login(username, password, clientIp(req));

    clearAttempts(req);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────────── Identity ────────────────────────────────

/**
 * The bootstrap call of the SPA: a stored token is only trusted once this
 * answers 200. Returns a little more than `req.user` so the header can greet
 * the teacher and show when they last signed in.
 */
router.get("/me", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const current = req.user;
    if (!current) throw httpError(401, "الرجاء تسجيل الدخول");

    const user = await prisma.user.findUnique({
      where: { id: current.id },
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    if (!user) throw httpError(401, "الرجاء تسجيل الدخول");

    res.json({ ...user, roleLabel: roleLabel(user.role), isOwner: user.role === "OWNER" });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────── Change own password ──────────────────────────

router.post(
  "/change-password",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const current = req.user;
      if (!current) throw httpError(401, "الرجاء تسجيل الدخول");

      const { oldPassword, newPassword } = parseBody(changePasswordSchema, req);
      if (oldPassword === newPassword) {
        throw badRequest("كلمة المرور الجديدة يجب أن تختلف عن الحالية");
      }

      const user = await changePassword(current.id, oldPassword, newPassword);

      // No before/after snapshot: there is nothing to record but the fact.
      await logAudit(req, {
        action: "UPDATE",
        entity: "User",
        entityId: user.id,
        summary: `غيّر «${user.name}» كلمة المرور الخاصة به`,
      });

      res.json({ ok: true, user });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
