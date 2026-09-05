/**
 * Live fan-out over Socket.IO — the other half of the audit trail.
 *
 * Two people share this system: الأستاذ أحمد and his assistant. When one of them
 * marks a grid, edits a template or changes a setting, the other's screen must
 * follow along instead of showing yesterday's numbers until a manual refresh.
 * Every write therefore calls `emitChange(entity)` right beside its `logAudit()`.
 *
 * Deliberately dumb: one event name, one payload shape, no rooms and no
 * per-entity channels. The client re-fetches the queries that care about
 * `entity` — which keeps the server free of UI knowledge and means a new screen
 * needs no server change at all.
 *
 * The handshake is authenticated with the same Bearer JWT the REST API uses
 * (not a cookie: the app also runs inside an Android WebView where cross-origin
 * cookies are unreliable) and, exactly like `requireAuth`, the account is
 * re-read from the database so a deactivated assistant cannot reconnect.
 */
import type { Server as HttpServer } from "http";

import { Server as IOServer, type Socket } from "socket.io";

import { prisma } from "./db";
import { toAuthUser, verifyToken, type AuthUser } from "./services/auth.service";

/** One channel for every entity — the client filters on `entity`. */
export const CHANGE_EVENT = "data:changed";

/** Sent to every connected client whenever anything is written. */
export type ChangeEvent = {
  /** "Student" | "Attendance" | "Grade" | "Message" | … — the Prisma model name. */
  entity: string;
  payload?: unknown;
  /** ISO instant, so a client can tell how stale a change is. */
  at: string;
};

type ClientToServer = Record<string, never>;
type ServerToClient = { "data:changed": (event: ChangeEvent) => void };
type InterServer = Record<string, never>;
type SocketData = { user: AuthUser };

export type RealtimeServer = IOServer<ClientToServer, ServerToClient, InterServer, SocketData>;
export type RealtimeSocket = Socket<ClientToServer, ServerToClient, InterServer, SocketData>;

const UNAUTHORISED = "غير مصرح بالاتصال";

let io: RealtimeServer | null = null;

// ──────────────────────────────── Handshake ────────────────────────────────

/**
 * `socket.handshake.auth.token` is the documented path; the Authorization
 * header is accepted too because the polling transport carries it and the
 * WebView bridge already sets it on every request.
 */
function readToken(socket: RealtimeSocket): string | null {
  const fromAuth = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof fromAuth === "string" && fromAuth.length > 0) return fromAuth;

  const header = socket.handshake.headers.authorization;
  const match = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match ? match[1].trim() : null;
}

/**
 * The socket equivalent of `requireAuth`: malformed, expired, unknown and
 * deactivated all get the same answer, and none of them get a connection.
 */
async function authenticate(socket: RealtimeSocket): Promise<AuthUser | null> {
  const payload = verifyToken(readToken(socket));
  if (!payload) return null;

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.isActive) return null;

  return toAuthUser(user);
}

// ─────────────────────────────────── Init ──────────────────────────────────

/**
 * The express CORS allow-list, read from the same `CORS_ORIGINS` variable.
 * Empty/unset → reflect the request origin, matching `cors({ origin: true })`.
 */
function corsOrigins(): string[] | boolean {
  const list = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return list.length > 0 ? list : true;
}

/** Attaches Socket.IO to the running HTTP server. Idempotent. */
export function initRealtime(httpServer: HttpServer): RealtimeServer {
  if (io) return io;

  const server: RealtimeServer = new IOServer<
    ClientToServer,
    ServerToClient,
    InterServer,
    SocketData
  >(httpServer, {
    path: "/socket.io",
    cors: { origin: corsOrigins(), credentials: true, methods: ["GET", "POST"] },
    // Keep polling available: the Android WebView drops idle websockets.
    transports: ["websocket", "polling"],
  });

  server.use((socket, next) => {
    authenticate(socket)
      .then((user) => {
        if (!user) {
          next(new Error(UNAUTHORISED));
          return;
        }
        socket.data.user = user;
        next();
      })
      .catch((err: unknown) => {
        // A database hiccup during the handshake is still a refused connection.
        console.error("[البث اللحظي] تعذّر التحقق من رمز الدخول:", err);
        next(new Error(UNAUTHORISED));
      });
  });

  server.on("connection", (socket) => {
    // A socket-level error must never reach the process-wide handler.
    socket.on("error", (err: unknown) => {
      console.error("[البث اللحظي] خطأ في الاتصال:", err);
    });
  });

  io = server;
  return server;
}

/** The live server, or null before `initRealtime()` has run. */
export const getRealtime = (): RealtimeServer | null => io;

/** How many clients are connected right now. */
export const connectedClients = (): number => io?.sockets.sockets.size ?? 0;

// ────────────────────────────────── Emitting ───────────────────────────────

/**
 * Broadcasts `{ entity, payload, at }` to every connected client.
 *
 * Safe to call before `initRealtime()`: a service under unit test, a seed
 * script or a cron tick has no HTTP server, and none of them should crash for
 * want of a websocket.
 */
export function emitChange(entity: string, payload?: unknown): void {
  if (!io) {
    console.warn(`[البث اللحظي] القناة غير مفعّلة — تم تجاهل تحديث «${entity}»`);
    return;
  }
  io.emit(CHANGE_EVENT, { entity, payload, at: new Date().toISOString() });
}

export default emitChange;
