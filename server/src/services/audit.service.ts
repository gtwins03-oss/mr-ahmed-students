/**
 * The audit trail — «سجل النشاط», visible to the OWNER only.
 *
 * Every meaningful write in the system funnels through `logAudit()`, which
 * snapshots *who* did *what*, *when*, and *from where*, plus optional
 * before/after JSON blobs.
 *
 * Three rules shape this file:
 *
 *  1. **It never throws.** An audit failure must never turn a successful save
 *     into a 500 for the teacher. Everything is wrapped in try/catch and the
 *     failure is logged to the console instead.
 *  2. **The actor is snapshotted, not referenced.** `userName` / `userRole` are
 *     copied into the row so a deleted account still reads correctly years
 *     later (the FK is `onDelete: SetNull`).
 *  3. **Secrets never land in a snapshot.** `before`/`after` pass through
 *     `redactSecrets()` first, so a password hash or a provider API token can
 *     never be read back out of the log.
 */
import type { Request } from "express";
import type { Prisma } from "@prisma/client";

import { prisma } from "../db";

// ────────────────────────── Vocabulary (Arabic UI) ─────────────────────────

/** The `action` column. Kept in sync with schema.prisma's inline comment. */
export const AUDIT_ACTIONS = [
  "LOGIN",
  "CREATE",
  "UPDATE",
  "DELETE",
  "ATTENDANCE",
  "GRADES",
  "MESSAGE",
  "SETTINGS",
] as const;

/** The `entity` column. */
export const AUDIT_ENTITIES = [
  "Student",
  "ClassGroup",
  "Session",
  "Attendance",
  "Assessment",
  "Grade",
  "Message",
  "MessageTemplate",
  "Setting",
  "User",
] as const;

/** Arabic labels so the audit screen never has to translate anything itself. */
export const ACTION_LABELS_AR: Record<string, string> = {
  LOGIN: "تسجيل دخول",
  CREATE: "إضافة",
  UPDATE: "تعديل",
  DELETE: "حذف",
  ATTENDANCE: "تسجيل حضور",
  GRADES: "رصد درجات",
  MESSAGE: "رسالة",
  SETTINGS: "إعدادات",
};

export const ENTITY_LABELS_AR: Record<string, string> = {
  Student: "طالب",
  ClassGroup: "مجموعة",
  Session: "حصة",
  Attendance: "حضور",
  Assessment: "اختبار",
  Grade: "درجة",
  Message: "رسالة",
  MessageTemplate: "قالب رسالة",
  Setting: "إعدادات",
  User: "مستخدم",
};

export const actionLabel = (action: string): string => ACTION_LABELS_AR[action] ?? action;
export const entityLabel = (entity: string): string => ENTITY_LABELS_AR[entity] ?? entity;

// ───────────────────────────────── Types ───────────────────────────────────

/** Who performed the action. `id` is null for cron-driven writes. */
export type AuditActor = {
  id: string | null;
  name: string;
  role: string;
};

/** A cron job or the bootstrap has no logged-in user behind it. */
export const SYSTEM_ACTOR: AuditActor = { id: null, name: "النظام", role: "SYSTEM" };

export type AuditInput = {
  action: string;
  entity: string;
  entityId?: string | null;
  /** A finished, human-readable ARABIC sentence: "حذف الطالب «أحمد محمود»". */
  summary: string;
  before?: unknown;
  after?: unknown;
};

/** An audit row as the API exposes it: `before`/`after` parsed back into JSON. */
export type AuditDto = {
  id: string;
  userId: string | null;
  userName: string;
  userRole: string;
  action: string;
  actionLabel: string;
  entity: string;
  entityLabel: string;
  entityId: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: Date;
};

export type AuditFilters = {
  userId?: string;
  action?: string;
  entity?: string;
  entityId?: string;
  /** "2026-09-01" — inclusive, local wall-clock day. */
  from?: string;
  /** "2026-09-30" — inclusive, local wall-clock day. */
  to?: string;
  /** Free text matched against `summary` (and the actor's name). */
  q?: string;
  /** Id of the last row of the previous page — cheaper than a growing offset. */
  cursor?: string;
  offset?: number;
  limit?: number;
};

export type AuditPage = {
  items: AuditDto[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
  hasMore: boolean;
};

export const AUDIT_LIMIT_DEFAULT = 50;
export const AUDIT_LIMIT_MAX = 200;

// ───────────────────────────── Snapshot helpers ────────────────────────────

/** Hard ceiling per snapshot column, so one bulk save cannot bloat the log. */
const MAX_SNAPSHOT_CHARS = 4000;

/** Any key whose *value* must never reach the log, whatever the nesting depth. */
const SECRET_KEY_PATTERN =
  /(password|passwordhash|secret|token|apitoken|authtoken|credential|jwt|authorization)/i;

const REDACTED = "«محجوب»";

/**
 * Deep-copies a value, replacing the value of any secret-looking key. Handles
 * cycles (a Prisma payload with back-references) via a `seen` set.
 */
function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;

  const obj = value as object;
  if (seen.has(obj)) return "«مرجع دائري»";
  seen.add(obj);

  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(v, seen);
  }
  return out;
}

/**
 * `unknown` → a JSON string of at most `MAX_SNAPSHOT_CHARS`, or null.
 *
 * Oversized payloads are replaced by a *still-valid* JSON marker carrying a
 * readable head, so `JSON.parse` on the way out never fails on a half-object.
 */
export function snapshot(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  let json: string;
  try {
    json = JSON.stringify(redactSecrets(value)) ?? "null";
  } catch {
    return null; // not serialisable — better no snapshot than a broken action
  }

  if (json.length <= MAX_SNAPSHOT_CHARS) return json;

  let head = json.slice(0, 3000);
  let marker = JSON.stringify({ _truncated: true, length: json.length, preview: head });
  // Escaping can inflate the head past the ceiling — shrink until it fits.
  while (marker.length > MAX_SNAPSHOT_CHARS && head.length > 1) {
    head = head.slice(0, Math.floor(head.length / 2));
    marker = JSON.stringify({ _truncated: true, length: json.length, preview: head });
  }
  return marker.slice(0, MAX_SNAPSHOT_CHARS);
}

/** Stored JSON string → object. A malformed blob is surfaced as raw text. */
export function parseSnapshot(raw: string | null): unknown {
  if (raw === null || raw === "") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function toAuditDto(row: {
  id: string;
  userId: string | null;
  userName: string;
  userRole: string;
  action: string;
  entity: string;
  entityId: string | null;
  summary: string;
  before: string | null;
  after: string | null;
  ip: string | null;
  createdAt: Date;
}): AuditDto {
  return {
    id: row.id,
    userId: row.userId,
    userName: row.userName,
    userRole: row.userRole,
    action: row.action,
    actionLabel: actionLabel(row.action),
    entity: row.entity,
    entityLabel: entityLabel(row.entity),
    entityId: row.entityId,
    summary: row.summary,
    before: parseSnapshot(row.before),
    after: parseSnapshot(row.after),
    ip: row.ip,
    createdAt: row.createdAt,
  };
}

// ─────────────────────────────── The client IP ─────────────────────────────

/**
 * Best-effort caller address, for display in the log.
 *
 * `x-forwarded-for` is read directly rather than through `req.ip`, because the
 * app runs without `trust proxy` (it is normally reached over the LAN). The
 * header is client-controllable, so this value is *informational only* — never
 * use it for a security decision such as rate limiting.
 */
export function clientIp(req: Request | null | undefined): string | null {
  if (!req) return null;

  const forwarded = req.headers?.["x-forwarded-for"];
  const rawForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first =
    typeof rawForwarded === "string" ? rawForwarded.split(",")[0]?.trim() : undefined;

  const ip = first || req.ip || req.socket?.remoteAddress || null;
  if (!ip) return null;

  // "::ffff:192.168.1.5" is an IPv4 address wearing an IPv6 hat.
  return ip.replace(/^::ffff:/, "").slice(0, 45);
}

// ──────────────────────────────── Writing ──────────────────────────────────

/**
 * Low-level write with an explicit actor. Used by the login flow, where the
 * user has just been authenticated and `req.user` is not populated yet.
 *
 * Never throws.
 */
export async function writeAudit(
  input: AuditInput & { actor: AuditActor; ip?: string | null },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: input.actor.id ?? null,
        userName: input.actor.name,
        userRole: input.actor.role,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        summary: input.summary,
        before: snapshot(input.before),
        after: snapshot(input.after),
        ip: input.ip ?? null,
      },
    });
  } catch (err) {
    // Deliberately swallowed: the user's action already succeeded.
    console.error("[سجل النشاط] تعذّر تسجيل الحدث:", err);
  }
}

/**
 * The entry point every route and service uses.
 *
 * `req` may be null for cron-driven writes (monthly reports, session
 * generation), in which case the actor is recorded as «النظام».
 *
 * Never throws — call it without a try/catch, and without awaiting it if the
 * response is more urgent than the log line.
 */
export async function logAudit(req: Request | null, input: AuditInput): Promise<void> {
  try {
    const user = req?.user;
    const actor: AuditActor = user
      ? { id: user.id, name: user.name, role: user.role }
      : SYSTEM_ACTOR;

    await writeAudit({ ...input, actor, ip: clientIp(req) });
  } catch (err) {
    console.error("[سجل النشاط] تعذّر تسجيل الحدث:", err);
  }
}

// ──────────────────────────────── Reading ──────────────────────────────────

/**
 * "2026-09-05" → a local-midnight (or end-of-day) Date, or null.
 *
 * The shared `zIsoDate` only checks the *shape* `\d{4}-\d{2}-\d{2}`, so
 * "2026-13-99" sails through it. Left alone, `new Date("2026-13-99T00:00:00")`
 * yields `Invalid Date`, which Prisma rejects with a 500 — a malformed filter
 * must be a 400, never a server error. The round-trip comparison below also
 * catches JS's silent roll-over, where "2026-02-30" would become 2 March.
 */
function parseDay(date: string, end: boolean): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const parsed = end
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);

  const rolledOver =
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day;

  return rolledOver ? null : parsed;
}

/** True when `date` is a real calendar day — routes use it to answer 400. */
export const isCalendarDate = (date: string): boolean => parseDay(date, false) !== null;

const startOfDay = (date: string): Date | null => parseDay(date, false);
const endOfDay = (date: string): Date | null => parseDay(date, true);

function buildWhere(filters: AuditFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};

  if (filters.userId) where.userId = filters.userId;
  if (filters.action) where.action = filters.action;
  if (filters.entity) where.entity = filters.entity;
  if (filters.entityId) where.entityId = filters.entityId;

  if (filters.from || filters.to) {
    const createdAt: Prisma.DateTimeFilter = {};

    // An unparseable bound is dropped rather than forwarded to Prisma as an
    // `Invalid Date`. Routes reject it up front; this keeps every other caller
    // (and any future cron-driven report) safe too.
    const gte = filters.from ? startOfDay(filters.from) : null;
    const lte = filters.to ? endOfDay(filters.to) : null;
    if (gte) createdAt.gte = gte;
    if (lte) createdAt.lte = lte;

    if (gte || lte) where.createdAt = createdAt;
  }

  // Arabic has no letter case, so SQLite's `contains` behaves as expected here.
  const q = filters.q?.trim();
  if (q) {
    where.OR = [{ summary: { contains: q } }, { userName: { contains: q } }];
  }

  return where;
}

/**
 * Newest first, with either cursor (`cursor=<last id>`) or offset pagination.
 *
 * The sort is `createdAt desc, id desc`: `createdAt` alone is not unique — a
 * bulk save writes several rows in the same millisecond — and a non-unique
 * ordering makes cursor pagination skip or repeat rows.
 */
export async function listAudit(filters: AuditFilters = {}): Promise<AuditPage> {
  const limit = Math.min(
    Math.max(Math.trunc(filters.limit ?? AUDIT_LIMIT_DEFAULT) || AUDIT_LIMIT_DEFAULT, 1),
    AUDIT_LIMIT_MAX,
  );
  const offset = Math.max(Math.trunc(filters.offset ?? 0) || 0, 0);
  const where = buildWhere(filters);

  const query: Prisma.AuditLogFindManyArgs = {
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1, // one extra row answers "is there a next page?"
  };

  if (filters.cursor) {
    query.cursor = { id: filters.cursor };
    query.skip = 1; // the cursor row itself belongs to the previous page
  } else if (offset > 0) {
    query.skip = offset;
  }

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany(query),
    prisma.auditLog.count({ where }),
  ]);

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(toAuditDto);

  return {
    items,
    total,
    limit,
    offset,
    nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    hasMore,
  };
}

/** One entry with its full before/after JSON, or null when it does not exist. */
export async function getAuditEntry(id: string): Promise<AuditDto | null> {
  const row = await prisma.auditLog.findUnique({ where: { id } });
  return row ? toAuditDto(row) : null;
}

// ─────────────────────────── Filter dropdown data ──────────────────────────

export type AuditFilterOption = { value: string; label: string; count: number };

export type AuditFilterOptions = {
  users: (AuditFilterOption & { role: string })[];
  actions: AuditFilterOption[];
  entities: AuditFilterOption[];
};

/**
 * The distinct users / actions / entities that actually appear in the log, so
 * the UI never offers a filter that would return nothing.
 *
 * Users are grouped on the *snapshotted* name: an account that was renamed —
 * or deleted, leaving `userId` null — still shows up under the name it acted
 * with at the time.
 */
export async function auditFilterOptions(): Promise<AuditFilterOptions> {
  const [userRows, actionRows, entityRows] = await Promise.all([
    prisma.auditLog.groupBy({
      by: ["userId", "userName", "userRole"],
      _count: { _all: true },
    }),
    prisma.auditLog.groupBy({ by: ["action"], _count: { _all: true } }),
    prisma.auditLog.groupBy({ by: ["entity"], _count: { _all: true } }),
  ]);

  const byCountThenName = (
    a: { count: number; label: string },
    b: { count: number; label: string },
  ): number => b.count - a.count || a.label.localeCompare(b.label, "ar");

  return {
    users: userRows
      .map((r) => ({
        // A deleted account has no id left to filter by — fall back to nothing
        // so the option is still visible but not selectable as a userId.
        value: r.userId ?? "",
        label: r.userName,
        role: r.userRole,
        count: r._count._all,
      }))
      .sort(byCountThenName),
    actions: actionRows
      .map((r) => ({ value: r.action, label: actionLabel(r.action), count: r._count._all }))
      .sort(byCountThenName),
    entities: entityRows
      .map((r) => ({ value: r.entity, label: entityLabel(r.entity), count: r._count._all }))
      .sort(byCountThenName),
  };
}
