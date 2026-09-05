/**
 * Route guards.
 *
 *   requireAuth   — any signed-in, active user (OWNER *or* ASSISTANT).
 *   requireOwner  — الأستاذ أحمد only.
 *
 * Permission model (deliberately blunt, as the owner asked):
 *   • ASSISTANTs may do **everything with data** — students, classes,
 *     attendance, grades, messages, templates, settings. No extra guards.
 *   • Exactly two areas are OWNER-only and invisible to assistants: the audit
 *     log (/api/audit) and user management (/api/users).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * These guards ALWAYS enforce. There is no bypass flag, and none should be
 * added here:
 *
 *   • `requireAuth` fails closed. A missing, malformed, expired or
 *     wrongly-signed token is a 401 — never an anonymous pass-through.
 *   • Nothing in this file ever fabricates an identity. In particular, no
 *     request is silently promoted to the seeded OWNER, because `requireOwner`
 *     trusts `req.user.role` completely: a fallback identity of "OWNER" would
 *     hand the audit log and user management to every caller, which is the one
 *     outcome the permission model exists to prevent.
 *
 * INTEGRATION NOTE for whoever mounts these in routes/index.ts: the web app has
 * no login screen yet, so putting a blanket `requireAuth` in front of the data
 * routes will 401 every existing page until that screen lands. Mount it on the
 * data routes when the UI is ready — but /api/users and /api/audit guard
 * themselves unconditionally either way, so an assistant (or an anonymous
 * caller) can never reach them. Stage the rollout by mount point, never by
 * weakening the checks below.
 */
import type { Request, Response, NextFunction } from "express";

import { prisma } from "../db";
import { verifyToken, type AuthUser } from "../services/auth.service";

// Makes `req.user` a first-class, typed property on every Express handler.
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export type { AuthUser };

const NOT_AUTHENTICATED = "الرجاء تسجيل الدخول";
const NOT_OWNER = "هذه الصفحة متاحة لصاحب الحساب فقط";
const ACCOUNT_DISABLED = "تم إيقاف هذا الحساب. تواصل مع صاحب الحساب.";

/** "Bearer eyJhbGci…" → "eyJhbGci…". Case-insensitive per RFC 6750. */
function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Verifies the Bearer token and loads the account behind it.
 *
 * The user is re-read from the database on every request rather than trusted
 * from the token body, so revoking access (deactivating an assistant, changing
 * their role) takes effect on their very next request instead of whenever
 * their 30-day token happens to expire.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Already resolved by an outer `router.use(requireAuth)` — do not pay for a
    // second lookup just because the sub-router guards itself as well.
    if (req.user) return next();

    const payload = verifyToken(bearerToken(req));
    if (!payload) {
      res.status(401).json({ error: NOT_AUTHENTICATED });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      res.status(401).json({ error: NOT_AUTHENTICATED });
      return;
    }

    // A valid token already proves who they are, so naming the real reason here
    // leaks nothing and saves a confused teacher a phone call.
    if (!user.isActive) {
      res.status(401).json({ error: ACCOUNT_DISABLED });
      return;
    }

    req.user = {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * OWNER-only gate.
 *
 * Mounted with `router.use(requireAuth, requireOwner)` at the top of
 * /api/users and /api/audit, i.e. **before any handler runs**. That ordering is
 * the point: an assistant hitting `/api/audit/<a real id>` and
 * `/api/audit/<nonsense>` gets byte-identical 403s, because neither request
 * ever reaches a database lookup. The route must not merely hide the data — it
 * must not confirm that the data exists.
 */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: NOT_AUTHENTICATED });
    return;
  }

  if (req.user.role !== "OWNER") {
    res.status(403).json({ error: NOT_OWNER });
    return;
  }

  next();
}

/** Convenience for mounting: `router.use("/users", ...ownerOnly, users)`. */
export const ownerOnly = [requireAuth, requireOwner] as const;
