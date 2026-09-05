/**
 * Authentication — login, JWT issuing/verification, password changes.
 *
 * **Why a Bearer token and not `express-session`** (docs/01-architecture.md
 * §1.6 predates this decision): the same build runs inside an Android WebView,
 * where cross-origin cookies are unreliable to the point of being unusable.
 * A token in the `Authorization` header works identically in the browser, in
 * the WebView, and from a shell script.
 *
 * **Why HS256 is implemented here rather than pulled from `jsonwebtoken`**:
 * the whole signing/verification surface we need is 30 lines of `node:crypto`,
 * and the server ships with exactly two runtime auth dependencies (`bcryptjs`
 * and the standard library). Nothing here deviates from RFC 7519 — the tokens
 * are ordinary `HS256` JWTs and validate in jwt.io.
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { User } from "@prisma/client";

import { prisma } from "../db";
import { badRequest, httpError, notFound } from "../lib/validate";
import { writeAudit } from "./audit.service";

// ──────────────────────────────── Constants ────────────────────────────────

export const ROLES = ["OWNER", "ASSISTANT"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_LABELS_AR: Record<string, string> = {
  OWNER: "صاحب الحساب",
  ASSISTANT: "مساعد",
};

export const roleLabel = (role: string): string => ROLE_LABELS_AR[role] ?? role;

/** Matches prisma/seed.ts — changing it invalidates nothing, bcrypt hashes
 *  carry their own cost factor, but keep the two in step anyway. */
export const BCRYPT_ROUNDS = 10;

export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 100;

/** One message for every failed login — see `login()`. */
const INVALID_CREDENTIALS = "اسم المستخدم أو كلمة المرور غير صحيحة";
const ACCOUNT_DISABLED = "تم إيقاف هذا الحساب. تواصل مع صاحب الحساب.";
const WRONG_CURRENT_PASSWORD = "كلمة المرور الحالية غير صحيحة";
const SAME_PASSWORD = "كلمة المرور الجديدة يجب أن تختلف عن الحالية";

/** The four fields every screen needs about "me". Never contains the hash. */
export type AuthUser = {
  id: string;
  name: string;
  username: string;
  role: string;
};

export type LoginResult = { token: string; user: AuthUser };

export const toAuthUser = (user: User): AuthUser => ({
  id: user.id,
  name: user.name,
  username: user.username,
  role: user.role,
});

// ───────────────────────────────── Passwords ───────────────────────────────

export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, BCRYPT_ROUNDS);

/**
 * A real bcrypt hash of a value nobody knows, compared against whenever the
 * username does not exist. Without it, "unknown user" would answer in ~0 ms
 * and "wrong password" in ~100 ms, and the difference alone would tell an
 * attacker which usernames are real.
 *
 * Computed once at module load (~100 ms at boot) so the very first failed
 * login is already indistinguishable from every later one.
 */
const DUMMY_HASH = bcrypt.hashSync(
  "no-such-account::" + crypto.randomBytes(16).toString("hex"),
  BCRYPT_ROUNDS,
);

// ────────────────────────────── JWT (HS256) ────────────────────────────────

export type TokenPayload = {
  /** User id. */
  sub: string;
  username: string;
  role: string;
  /** Issued-at / expiry, seconds since the epoch (RFC 7519). */
  iat: number;
  exp: number;
};

const DEFAULT_EXPIRES_IN = "30d";

/**
 * Read at call time rather than module load: `dotenv.config()` runs in
 * index.ts, and tests may set the variable after importing this file.
 */
function jwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    console.error(
      "[المصادقة] JWT_SECRET غير مضبوط في server/.env — لا يمكن إصدار رموز الدخول.",
    );
    throw httpError(500, "إعداد المصادقة غير مكتمل على الخادم");
  }
  return secret;
}

/** "30d" | "12h" | "45m" | "3600" → seconds. */
export function parseExpiry(raw: string | undefined): number {
  const value = (raw ?? DEFAULT_EXPIRES_IN).trim();
  const match = /^(\d+)\s*([smhdw]?)$/i.exec(value);
  if (!match) return parseExpiry(DEFAULT_EXPIRES_IN);

  const amount = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  const seconds: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  const total = amount * (seconds[unit] ?? 1);

  return total > 0 ? total : parseExpiry(DEFAULT_EXPIRES_IN);
}

const base64url = (input: Buffer | string): string =>
  (Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8")).toString("base64url");

const sign = (data: string): string =>
  base64url(crypto.createHmac("sha256", jwtSecret()).update(data).digest());

/** Issues a signed HS256 token for a user. */
export function signToken(user: User | AuthUser): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    sub: user.id,
    username: user.username,
    role: user.role,
    iat: now,
    exp: now + parseExpiry(process.env.JWT_EXPIRES_IN),
  };

  const head = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

/**
 * Verifies signature, algorithm and expiry.
 *
 * Returns null for *every* kind of failure — malformed, wrong signature,
 * expired — because the caller (requireAuth) answers all of them identically
 * and must not branch on the reason.
 */
export function verifyToken(token: string | null | undefined): TokenPayload | null {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, signature] = parts;

  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as {
      alg?: unknown;
      typ?: unknown;
    };
    // Reject "alg": "none" and any algorithm confusion outright.
    if (header.alg !== "HS256") return null;

    const expected = Buffer.from(sign(`${head}.${body}`), "utf8");
    const actual = Buffer.from(signature, "utf8");
    if (expected.length !== actual.length) return null;
    if (!crypto.timingSafeEqual(expected, actual)) return null;

    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as
      | Partial<TokenPayload>
      | null;
    if (!payload || typeof payload.sub !== "string" || payload.sub === "") return null;
    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return {
      sub: payload.sub,
      username: typeof payload.username === "string" ? payload.username : "",
      role: typeof payload.role === "string" ? payload.role : "ASSISTANT",
      iat: typeof payload.iat === "number" ? payload.iat : 0,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────── Login ─────────────────────────────────

/**
 * Exact match first, then the lower-cased form.
 *
 * Android keyboards capitalise the first letter of a text field by default, so
 * a teacher typing their own username gets "Ahmed" for a stored "ahmed".
 * `users.ts` stores every new username lower-cased; the exact-match attempt is
 * what keeps a pre-existing mixed-case account (e.g. from an early seed)
 * working. Both lookups are indexed and cost far less than the bcrypt compare
 * that always follows, so this leaks no useful timing signal.
 */
async function findLoginUser(username: string): Promise<User | null> {
  const trimmed = username.trim();
  if (trimmed === "") return null;

  const exact = await prisma.user.findUnique({ where: { username: trimmed } });
  if (exact) return exact;

  const lower = trimmed.toLowerCase();
  if (lower === trimmed) return null;
  return prisma.user.findUnique({ where: { username: lower } });
}

/**
 * Verifies credentials, stamps `lastLoginAt` and records a LOGIN audit entry.
 *
 * "Unknown username" and "wrong password" produce the *same* message and take
 * the *same* time — a bcrypt compare runs either way, against `DUMMY_HASH`
 * when there is no such account.
 */
export async function login(
  username: string,
  password: string,
  ip?: string | null,
): Promise<LoginResult> {
  const user = await findLoginUser(username);

  // Always spend the bcrypt cost, even when there is nothing to compare with.
  const passwordOk = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !passwordOk) throw httpError(401, INVALID_CREDENTIALS);

  // Only revealed to someone who already proved they own the password, so this
  // discloses nothing an attacker does not already have.
  if (!user.isActive) throw httpError(403, ACCOUNT_DISABLED);

  const [updated] = await Promise.all([
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    // `req.user` does not exist yet at this point — write with an explicit actor.
    writeAudit({
      actor: { id: user.id, name: user.name, role: user.role },
      action: "LOGIN",
      entity: "User",
      entityId: user.id,
      summary: `سجّل «${user.name}» الدخول إلى النظام`,
      ip: ip ?? null,
    }),
  ]);

  return { token: signToken(updated), user: toAuthUser(updated) };
}

// ────────────────────────────── Change password ────────────────────────────

/**
 * Self-service password change. The *current* password is required — an
 * unattended, unlocked laptop must not be enough to lock the owner out.
 */
export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<AuthUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound("المستخدم غير موجود");

  const currentOk = await bcrypt.compare(oldPassword, user.passwordHash);
  if (!currentOk) throw httpError(400, WRONG_CURRENT_PASSWORD);

  if (oldPassword === newPassword) throw badRequest(SAME_PASSWORD);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  return toAuthUser(updated);
}
