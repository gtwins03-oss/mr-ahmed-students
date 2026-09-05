/**
 * Tiny validation / HTTP-error helpers shared by every route.
 *
 * Rules:
 *  • Every request body goes through `parseBody(schema, req)`.
 *  • A validation failure throws an `HttpError` with status 400 and an Arabic
 *    message; `index.ts`'s central error handler turns it into
 *    `{ error: "..." }` and never leaks a stack trace.
 */
import type { Request } from "express";
import { z } from "zod";

// ───────────────────────────── HTTP errors ─────────────────────────────

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    // Required when targeting ES2022 with a subclassed built-in.
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

export const httpError = (status: number, message: string): HttpError =>
  new HttpError(status, message);

export const badRequest = (message = "بيانات غير صالحة"): HttpError =>
  new HttpError(400, message);

export const notFound = (message = "العنصر المطلوب غير موجود"): HttpError =>
  new HttpError(404, message);

export const conflict = (message = "تعارض في البيانات"): HttpError =>
  new HttpError(409, message);

// ─────────────────────── Arabic defaults for zod ───────────────────────

/**
 * The whole UI is Arabic, so zod's built-in English messages ("Required",
 * "Expected number, received string") must never reach the teacher. Explicit
 * per-field messages still win — this map only fills the gaps.
 */
const arabicErrorMap: z.ZodErrorMap = (issue) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === "undefined" || issue.received === "null") {
        return { message: "هذا الحقل مطلوب" };
      }
      return { message: "نوع القيمة غير صحيح" };

    case z.ZodIssueCode.invalid_enum_value:
      return { message: "القيمة المختارة غير مسموح بها" };

    case z.ZodIssueCode.too_small:
      if (issue.type === "string") return { message: "النص قصير جداً" };
      if (issue.type === "array") return { message: "القائمة قصيرة جداً" };
      return { message: "القيمة أقل من الحد المسموح" };

    case z.ZodIssueCode.too_big:
      if (issue.type === "string") return { message: "النص طويل جداً" };
      if (issue.type === "array") return { message: "القائمة طويلة جداً" };
      return { message: "القيمة أكبر من الحد المسموح" };

    case z.ZodIssueCode.invalid_string:
      return { message: "صيغة النص غير صحيحة" };

    case z.ZodIssueCode.unrecognized_keys:
      return { message: "توجد حقول غير معروفة" };

    default:
      return { message: "قيمة غير صالحة" };
  }
};

z.setErrorMap(arabicErrorMap);

// ───────────────────────────── Zod plumbing ────────────────────────────

/** "name: الاسم مطلوب ، parentPhone: رقم غير صالح" */
export function formatZodError(error: z.ZodError): string {
  const parts = error.issues.slice(0, 4).map((issue) => {
    const path = issue.path.filter((p) => typeof p !== "symbol").join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return `بيانات غير صالحة — ${parts.join(" ، ")}`;
}

/**
 * Validate an arbitrary value, throwing a 400-shaped error on failure.
 * Generic over the schema (not its output) so that transforming schemas report
 * their *output* type to the caller.
 */
export function parseValue<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(formatZodError(result.error));
  return result.data;
}

/** Validate `req.body`. Throws a 400-shaped `HttpError` when it does not fit. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  return parseValue(schema, req.body ?? {});
}

/** Validate `req.query` (values arrive as strings — use `z.coerce` where needed). */
export function parseQuery<S extends z.ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  return parseValue(schema, req.query ?? {});
}

/** Validate `req.params`. */
export function parseParams<S extends z.ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  return parseValue(schema, req.params ?? {});
}

// ──────────────────────── Query-string accessors ───────────────────────

/** First string value of `?key=`, or undefined when absent/empty. */
export function queryString(req: Request, key: string): string | undefined {
  const raw = req.query[key];
  if (typeof raw === "string") return raw.length > 0 ? raw : undefined;
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    return raw[0].length > 0 ? raw[0] : undefined;
  }
  return undefined;
}

/** `?flag=true|1|yes` → true, `?flag=false|0|no` → false, missing → undefined. */
export function queryBool(req: Request, key: string): boolean | undefined {
  const raw = queryString(req, key)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (["true", "1", "yes", "y"].includes(raw)) return true;
  if (["false", "0", "no", "n"].includes(raw)) return false;
  return undefined;
}

/** `?id=` required path/query identifier. */
export const zId = z.string().trim().min(1, "المعرّف مطلوب");

/** "2026-09-05" */
export const zIsoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ يجب أن يكون بصيغة YYYY-MM-DD");

/** "2026-09" */
export const zMonth = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "الشهر يجب أن يكون بصيغة YYYY-MM");

/** "16:00" — 24-hour wall clock. */
export const zTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "الوقت يجب أن يكون بصيغة HH:MM");

/** Trims, and turns "" into null so optional text fields clear properly. */
export const zOptionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max, `النص طويل جداً (الحد ${max} حرف)`)
    .nullish()
    .transform((v) => (v === undefined || v === null || v === "" ? null : v));

// ─────────────────────────── Prisma error codes ────────────────────────

/**
 * Prisma's known-request errors carry a `code` such as "P2002" (unique
 * constraint) or "P2025" (record not found). Read it without importing the
 * Prisma namespace so this helper stays dependency-free.
 */
export function prismaErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^P\d{4}$/.test(code)) return code;
  }
  return undefined;
}

export const isNotFoundError = (err: unknown): boolean => prismaErrorCode(err) === "P2025";
export const isUniqueError = (err: unknown): boolean => prismaErrorCode(err) === "P2002";
