/**
 * Realtime cache invalidation.
 *
 * The server emits a single event — `data:changed` with `{ entity, id }` —
 * whenever anything meaningful is written. This module turns that into
 * react-query invalidations, so an assistant marking attendance on her phone
 * updates الأستاذ أحمد's dashboard on his laptop without either of them
 * pressing refresh.
 *
 * Two deliberate choices for a weak mobile link:
 *
 *  - `transports: ["websocket", "polling"]` with `tryAllTransports`. A flaky
 *    carrier or a captive portal that blocks WebSocket upgrades degrades to
 *    long-polling instead of going dark.
 *  - The socket is **advisory only**. Every page still works if it never
 *    connects — polling and `refetchOnReconnect` cover the same ground more
 *    slowly. That is why a socket that has never connected reports
 *    "connecting", not "offline": the server build may simply not speak
 *    socket.io yet, and shouting "لا يوجد اتصال" at the teacher for that would
 *    be a lie.
 */

import { useEffect, useSyncExternalStore } from "react";
import { io, type Socket } from "socket.io-client";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { getSocketUrl } from "./apiBase";
import { getToken } from "./auth";

/** The event every server-side write broadcasts. */
export const DATA_CHANGED_EVENT = "data:changed";

export type ConnectionState = "connected" | "connecting" | "offline";

export interface DataChangedPayload {
  /** "Student" | "ClassGroup" | "Session" | "Attendance" | … (see AuditLog.entity). */
  entity?: string;
  id?: string;
  action?: string;
}

/* ─────────────────────── connection-state store ───────────────────────── */

let state: ConnectionState = "connecting";
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(next: ConnectionState): void {
  if (next === state) return;
  state = next;
  emit();
}

function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getConnectionState(): ConnectionState {
  return state;
}

/** Subscribes a component to the live socket state. */
export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(subscribeConnection, getConnectionState, getConnectionState);
}

/* ─────────────────────── entity → query keys map ──────────────────────── */

/**
 * Query-key roots used across the app. Invalidation is prefix-based, so
 * ["messages"] also covers ["messages", { status: "PENDING" }] and
 * ["messages", "list"].
 */
const KEYS_BY_ENTITY: Record<string, string[]> = {
  student: ["students", "student", "student-report", "classes", "dashboard"],
  classgroup: ["classes", "sessions", "students", "dashboard"],
  enrollment: ["classes", "students", "sessions"],
  scheduleslot: ["classes", "sessions", "dashboard"],
  session: ["sessions", "dashboard"],
  attendance: ["sessions", "student", "student-report", "dashboard", "messages"],
  assessment: ["assessments", "assessment", "dashboard"],
  grade: ["assessment", "assessments", "student", "student-report", "dashboard", "messages"],
  message: ["messages", "dashboard"],
  messagetemplate: ["templates"],
  setting: ["settings"],
  user: ["users"],
  auditlog: ["audit"],
};

/** "ClassGroups" / "class_groups" / "classGroup" all mean the same table. */
function entityKey(entity: string): string {
  const slug = entity.toLowerCase().replace(/[^a-z]/g, "");
  if (slug in KEYS_BY_ENTITY) return slug;
  const singular = slug.replace(/s$/, "");
  return singular in KEYS_BY_ENTITY ? singular : "";
}

/**
 * Invalidates everything touched by a change. An unrecognised (or missing)
 * entity invalidates the whole cache: over-fetching once is cheaper than
 * showing a stale attendance grid.
 */
export function invalidateForEntity(queryClient: QueryClient, entity: string | undefined): void {
  const key = entity ? entityKey(entity) : "";
  if (key === "") {
    void queryClient.invalidateQueries();
    return;
  }
  for (const queryKey of KEYS_BY_ENTITY[key]) {
    void queryClient.invalidateQueries({ queryKey: [queryKey] });
  }
  // The audit log records every write, so it is always one step behind.
  void queryClient.invalidateQueries({ queryKey: ["audit"] });
}

/* ──────────────────────────── the socket ──────────────────────────────── */

let socket: Socket | null = null;
/** url + token: a change in either means the old connection is worthless. */
let socketKey = "";
let activeQueryClient: QueryClient | null = null;
/** Until the first successful connect we do not know if the server speaks socket.io. */
let everConnected = false;

function openSocket(queryClient: QueryClient): Socket {
  const url = getSocketUrl();
  const token = getToken() ?? "";
  const key = `${url}|${token}`;

  if (socket && socketKey === key) {
    activeQueryClient = queryClient;
    return socket;
  }

  closeSocket();
  activeQueryClient = queryClient;
  socketKey = key;
  setState("connecting");

  const next = io(url, {
    // Try the cheap transport first, then fall back rather than give up.
    transports: ["websocket", "polling"],
    tryAllTransports: true,
    auth: { token },
    withCredentials: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 10_000,
    randomizationFactor: 0.5,
    timeout: 10_000,
  });

  next.on("connect", () => {
    const isReconnect = everConnected;
    everConnected = true;
    setState("connected");
    if (!activeQueryClient) return;
    void activeQueryClient.resumePausedMutations();
    // Whatever changed while we were away is invisible to us, so refetch —
    // but only after a *re*connect. On the first connect the pages have just
    // loaded their data and a second round trip would only cost the teacher
    // bandwidth she does not have.
    if (isReconnect) void activeQueryClient.invalidateQueries();
  });

  next.on("disconnect", () => {
    setState(everConnected ? "offline" : "connecting");
  });

  next.on("connect_error", () => {
    // A server without socket.io support must not be reported as "offline";
    // only a connection we once had and then lost counts as a real drop.
    setState(everConnected ? "offline" : "connecting");
  });

  // Note: no listener is attached to `next.io` (the Manager). socket.io caches
  // one Manager per URL, so a listener added there would survive closeSocket()
  // and pile up on every reconnect. Everything needed is on the socket itself.

  next.on(DATA_CHANGED_EVENT, (payload: DataChangedPayload | string | undefined) => {
    if (!activeQueryClient) return;
    const entity = typeof payload === "string" ? payload : payload?.entity;
    invalidateForEntity(activeQueryClient, entity);
  });

  socket = next;
  return next;
}

function closeSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  socketKey = "";
  everConnected = false;
  setState("connecting");
}

/**
 * Rebuilds the connection against the current server address and token —
 * called after the teacher changes the address on «إعداد الخادم».
 */
export function reconnectRealtime(): void {
  if (!activeQueryClient) return;
  const queryClient = activeQueryClient;
  closeSocket();
  openSocket(queryClient);
}

/* ──────────────────────────── the hook ────────────────────────────────── */

/**
 * Opens the realtime connection and keeps the react-query cache in step with
 * it. Mounted exactly once, from `components/Layout.tsx`.
 */
export function useRealtimeSync(): ConnectionState {
  const queryClient = useQueryClient();
  // Not reactive by itself, but Layout re-renders on every auth change, so a
  // login or logout produces a new key here and a fresh, correctly
  // authenticated socket.
  const token = getToken() ?? "";

  useEffect(() => {
    const active = openSocket(queryClient);

    // A WebView coming back from sleep often keeps a socket that is already
    // dead; nudging it on the browser's own online event reconnects in
    // milliseconds instead of waiting out the backoff.
    const onOnline = () => {
      if (!active.connected) active.connect();
      void queryClient.resumePausedMutations();
    };
    const onOffline = () => setState(everConnected ? "offline" : "connecting");

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      closeSocket();
    };
  }, [queryClient, token]);

  return useConnectionState();
}
