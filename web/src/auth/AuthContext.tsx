/**
 * Session state for the whole SPA.
 *
 * Auth is a **JWT Bearer token, not a cookie**: the same build is loaded inside
 * an Android WebView, where cross-origin cookies are unreliable. The token
 * therefore lives in localStorage and travels in the `Authorization` header,
 * which `api/client.ts` attaches by calling `getToken()` below — that is why
 * the helper is a plain function and not a hook.
 *
 * Two things are cached in localStorage:
 *   "tutor.token" — the JWT.
 *   "tutor.user"  — the last known account, so reopening the app paints the
 *                   real UI immediately instead of flashing the login screen
 *                   while `GET /api/auth/me` is in flight.
 *
 * Validation policy on mount: a 401 means the token is dead, so the session is
 * cleared and the login screen comes back. Anything else (server down, phone
 * offline, wrong server address) keeps the cached session — the teacher opening
 * the app before the laptop has booted should not be logged out.
 *
 * `src/lib/auth.ts` re-exports this module; import from there, since that is
 * the path `api/client.ts`, `App.tsx` and `main.tsx` all use. The server
 * address is a separate concern and lives in `src/lib/apiBase.ts`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

import { AUTH_EXPIRED_EVENT, ApiError, api } from "../api/client";
import type { LoginResponse, User, UserRole } from "../api/types";

/* ─────────────────────────── localStorage keys ────────────────────────── */

export const TOKEN_KEY = "tutor.token";
export const USER_KEY = "tutor.user";

/** localStorage throws in a locked-down WebView; never let that crash boot. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the session just will not survive a reload */
  }
}

/* ───────────────────────────── token access ───────────────────────────── */

/** `undefined` = not read from storage yet. */
let tokenCache: string | null | undefined;

/**
 * The current Bearer token, or null. Non-hook on purpose: `api/client.ts`
 * calls it from module scope on every request.
 */
export function getToken(): string | null {
  if (tokenCache === undefined) tokenCache = readStored(TOKEN_KEY);
  return tokenCache;
}

/** Persists (or drops) the Bearer token. Storage and cache stay in step. */
export function setToken(token: string | null): void {
  tokenCache = token;
  writeStored(TOKEN_KEY, token);
}

/**
 * Drops the stored session. Called by `api/client.ts` the moment the server
 * refuses the token with a 401 — it cannot use a hook, and by then the
 * provider may not even be mounted. The provider hears about it through the
 * `auth:expired` event that the client dispatches straight after.
 */
export function clearToken(): void {
  setToken(null);
  writeStored(USER_KEY, null);
}

/* ────────────────────────────── user caching ──────────────────────────── */

/**
 * Normalises an unknown payload into a complete `User`, or null. Returning a
 * fully-populated object (rather than type-guarding a partial one) is what
 * keeps "undefined" off the screen when a field is missing.
 */
function toUser(value: unknown): User | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  // Tolerate a `{ user: {...} }` envelope, which is how some servers answer
  // /auth/me. Anything deeper than that is not a shape worth guessing at.
  if (typeof raw.username !== "string" && typeof raw.user === "object" && raw.user !== null) {
    return toUser(raw.user);
  }

  const { id, name, username, role } = raw;
  if (typeof id !== "string" || typeof username !== "string") return null;
  const safeRole: UserRole = role === "OWNER" ? "OWNER" : "ASSISTANT";
  return {
    id,
    name: typeof name === "string" && name.trim() !== "" ? name : username,
    username,
    role: safeRole,
    isActive: raw.isActive !== false,
    lastLoginAt: typeof raw.lastLoginAt === "string" ? raw.lastLoginAt : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
  };
}

function readCachedUser(): User | null {
  const raw = readStored(USER_KEY);
  if (!raw) return null;
  try {
    return toUser(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function writeCachedUser(user: User | null): void {
  writeStored(USER_KEY, user === null ? null : JSON.stringify(user));
}

/* ─────────────────────────────── context ──────────────────────────────── */

export interface AuthValue {
  /** The signed-in account, or null when there is no usable session. */
  user: User | null;
  token: string | null;
  /** True only while the very first `/auth/me` check is still running. */
  isLoading: boolean;
  /** OWNER sees the audit log and user management; ASSISTANT never does. */
  isOwner: boolean;
  login: (username: string, password: string) => Promise<User>;
  logout: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Mounted by `main.tsx` inside both the router and the query provider, so a
 * logout can drop the previous account's cached data on the way out.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [user, setUser] = useState<User | null>(() =>
    getToken() === null ? null : readCachedUser(),
  );
  // Only block the first paint when there is a token but nothing cached to
  // show; with a cached account the app renders now and revalidates quietly.
  const [isLoading, setIsLoading] = useState<boolean>(
    () => getToken() !== null && readCachedUser() === null,
  );

  const clearSession = useCallback(() => {
    clearToken();
    setTokenState(null);
    setUser(null);
  }, []);

  // `api/client.ts` clears the token itself on a 401 and announces it; mirror
  // that into React state so the UI stops showing a session that is gone.
  useEffect(() => {
    const onExpired = () => clearSession();
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [clearSession]);

  useEffect(() => {
    if (getToken() === null) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const me = await api.get<User>("/auth/me");
        if (cancelled) return;
        const fresh = toUser(me);
        if (fresh) {
          setUser(fresh);
          writeCachedUser(fresh);
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) clearSession();
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clearSession]);

  const login = useCallback(async (username: string, password: string): Promise<User> => {
    const res = await api.post<LoginResponse>("/auth/login", {
      username: username.trim(),
      password,
    });

    const nextToken = typeof res?.token === "string" ? res.token.trim() : "";
    const nextUser = toUser(res?.user);
    if (nextToken === "" || nextUser === null) {
      throw new ApiError("ردّ الخادم غير مفهوم — تأكد من تحديث البرنامج على الجهازين.", 500);
    }

    setToken(nextToken);
    writeCachedUser(nextUser);
    setTokenState(nextToken);
    setUser(nextUser);
    setIsLoading(false);
    return nextUser;
  }, []);

  const logout = useCallback(() => {
    clearSession();
    // This runs on a shared phone: drop everything the account that just left
    // had loaded, including the copy react-query persisted to localStorage.
    queryClient.clear();
  }, [clearSession, queryClient]);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      token,
      isLoading,
      isOwner: user?.role === "OWNER",
      login,
      logout,
    }),
    [user, token, isLoading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error("useAuth() لا يعمل إلا داخل <AuthProvider>");
  }
  return value;
}

export default AuthProvider;
