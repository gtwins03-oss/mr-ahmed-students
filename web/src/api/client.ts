/**
 * Thin typed fetch wrapper around the Express API.
 *
 * Every route lives under `/api`, resolved against the configured server
 * address (see `lib/apiBase.ts`): a relative path in the browser, an absolute
 * "http://192.168.1.10:4000" inside the Android APK, which has no dev proxy.
 *
 * The server always answers a failure with `{ error: "<arabic message>" }`.
 * That string is what the user sees, so it becomes the thrown Error's message
 * verbatim — components can render `err.message` without translating anything.
 *
 * Written for a weak mobile connection, so three things happen here that a
 * localhost-only client would not need:
 *
 *  - **A 15s timeout.** A dying cellular link does not fail, it hangs. Every
 *    request is aborted at 15s and reported as a network error.
 *  - **`isNetworkError`.** Lets react-query retry a dropped packet while
 *    leaving a 400 (bad input) or 403 (forbidden) alone. Retries live in
 *    react-query — never here, or the two would multiply.
 *  - **401 handling.** The stored token is dropped and `auth:expired` is
 *    dispatched on `window`, which sends the app back to the login screen.
 *
 * Auth is a JWT Bearer token, never a cookie: the app also runs inside an
 * Android WebView, where cross-origin cookies are unreliable.
 */

import { apiUrl } from "../lib/apiBase";
import { clearToken, getToken } from "../lib/auth";

/** Dispatched on `window` when the server rejects the stored token. */
export const AUTH_EXPIRED_EVENT = "auth:expired";

/** A request that has not answered in 15s is treated as a dead connection. */
export const REQUEST_TIMEOUT_MS = 15_000;

const FALLBACK_ERROR = "حدث خطأ غير متوقع";
const NETWORK_ERROR = "تعذّر الاتصال بالخادم. تأكد من أنه يعمل ثم أعد المحاولة.";
const TIMEOUT_ERROR = "انتهت مهلة الاتصال بالخادم. الشبكة ضعيفة — سنعيد المحاولة تلقائياً.";
const SESSION_ERROR = "انتهت الجلسة، برجاء تسجيل الدخول مرة أخرى";

/** An error carrying the HTTP status alongside the Arabic message. */
export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;
  /** True when the request never reached the server (offline, DNS, timeout). */
  readonly isNetworkError: boolean;

  constructor(message: string, status: number, payload: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
    this.isNetworkError = status === 0;
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Pulls the Arabic `error` field out of an unknown JSON body. */
function readErrorMessage(payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    const { error } = payload as { error?: unknown };
    if (typeof error === "string" && error.trim() !== "") return error;
  }
  return FALLBACK_ERROR;
}

/**
 * Signing in with the wrong password is also a 401, but it is not an expired
 * session — logging the user out there would wipe the form they are typing in.
 */
function isLoginRequest(path: string): boolean {
  return path.startsWith("/auth/login");
}

/** Drops the dead token and lets the router bounce the user to /login. */
function handleUnauthorised(path: string): void {
  if (isLoginRequest(path)) return;
  clearToken();
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}

async function request<T>(method: Method, url: string, body?: unknown): Promise<T> {
  const hasBody = body !== undefined;
  const token = getToken();

  const headers: Record<string, string> = { Accept: "application/json" };
  if (hasBody) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  let text: string;
  try {
    // fetch() only rejects on network-level failures — server down, DNS, CORS,
    // or our own abort. Everything else, including 500, resolves normally.
    res = await fetch(apiUrl(url), {
      method,
      // Bearer tokens only; cookies are deliberately not sent cross-origin.
      credentials: "omit",
      signal: controller.signal,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch {
    throw controller.signal.aborted
      ? new ApiError(TIMEOUT_ERROR, 0)
      : new ApiError(NETWORK_ERROR, 0);
  } finally {
    window.clearTimeout(timer);
  }

  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text; // non-JSON body (an HTML error page, say)
    }
  }

  if (res.status === 401) {
    handleUnauthorised(url);
    throw new ApiError(readErrorMessage(payload) || SESSION_ERROR, 401, payload);
  }

  if (!res.ok) throw new ApiError(readErrorMessage(payload), res.status, payload);

  // 204 No Content and empty bodies come back as undefined.
  return payload as T;
}

export const api = {
  get: <T>(url: string): Promise<T> => request<T>("GET", url),
  post: <T>(url: string, body?: unknown): Promise<T> => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown): Promise<T> => request<T>("PUT", url, body ?? {}),
  patch: <T>(url: string, body?: unknown): Promise<T> => request<T>("PATCH", url, body ?? {}),
  del: <T>(url: string): Promise<T> => request<T>("DELETE", url),
};

/**
 * Builds a query string, dropping null/undefined/empty values so
 * `buildQuery({ q: "", classId: "abc" })` yields "?classId=abc".
 */
export function buildQuery(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Narrows an unknown thrown value to a user-presentable Arabic message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return FALLBACK_ERROR;
}

/** True when the request died on the wire rather than being refused by the API. */
export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && err.isNetworkError;
}

/**
 * Retry policy shared by every query and mutation (wired up in main.tsx).
 *
 * Retrying a dropped packet is free; retrying a rejected password, a
 * validation error or a 403 just burns battery and hammers a weak link, so
 * only network failures and server-side faults (5xx) come back for more.
 */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return err.isNetworkError || err.status >= 500;
}
