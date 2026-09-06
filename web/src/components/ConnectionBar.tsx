/**
 * The connection strip that sits under the header.
 *
 * Rules it follows, in order of importance:
 *  1. **Silence when everything is fine.** A permanent "متصل ✓" badge teaches
 *     the teacher to ignore the bar, which defeats the point of having one.
 *  2. **Never claim data was lost.** Mutations are queued and replayed by
 *     react-query, so the offline message is a promise ("سيتم حفظ تعديلاتك"),
 *     not a warning.
 *  3. **Confirm recovery.** Three seconds of «تمت المزامنة» after the link
 *     comes back, then it disappears again.
 *
 * Offline is decided by `navigator.onLine` *and* the socket: a WebView on a
 * dying carrier link routinely reports `onLine === true` while nothing at all
 * reaches the server, and a socket that connected once and then dropped is the
 * more honest signal. A socket that has never connected is ignored — see
 * `lib/socket.ts`.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, WifiOff } from "lucide-react";

import { arNum } from "../lib/format";
import { useConnectionState } from "../lib/socket";
import { cn } from "./ui";

/* ─────────────────────────── browser online state ─────────────────────── */

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/* ────────────────────────── queued mutation count ─────────────────────── */

/**
 * How many writes are still in flight or parked waiting for the network.
 * Read straight from the mutation cache so the count is exact, including the
 * mutations react-query restored from localStorage after a restart.
 */
function usePendingMutationCount(): number {
  const queryClient = useQueryClient();
  const [count, setCount] = useState(0);

  useEffect(() => {
    const cache = queryClient.getMutationCache();
    const read = () =>
      cache.getAll().filter((m) => m.state.isPaused || m.state.status === "pending").length;

    setCount(read());
    return cache.subscribe(() => setCount(read()));
  }, [queryClient]);

  return count;
}

/** ١ تعديل · تعديلين · ٣ تعديلات · ١١ تعديلاً */
function pendingLabel(count: number): string {
  if (count === 1) return "تعديل واحد";
  if (count === 2) return "تعديلين";
  if (count <= 10) return `${arNum(count)} تعديلات`;
  return `${arNum(count)} تعديلاً`;
}

/**
 * True once `active` has held for `delayMs` without interruption.
 *
 * Marking a class present fires one mutation per tap, and on a healthy link
 * each finishes in well under a second. Announcing every one of those would
 * turn the bar into a strobe light, so uploads are only reported once they are
 * slow enough to be worth mentioning.
 */
function useSustained(active: boolean, delayMs: number): boolean {
  const [sustained, setSustained] = useState(false);

  useEffect(() => {
    if (!active) {
      setSustained(false);
      return;
    }
    const timer = window.setTimeout(() => setSustained(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);

  return sustained;
}

/* ──────────────────────────────── the bar ─────────────────────────────── */

/**
 * One hairline strip. The tint and the ink are the only things that vary, and
 * both come from the semantic tokens in index.css — the same four that carry
 * attendance meaning — so the bar re-themes with everything else instead of
 * painting a pastel Tailwind swatch onto the near-black canvas.
 */
const BAR_BASE =
  "flex items-center justify-center gap-2 border-b border-[var(--border)] px-4 py-1.5 text-xs font-semibold sm:text-sm";

export function ConnectionBar() {
  const browserOnline = useOnline();
  const socketState = useConnectionState();
  const pending = usePendingMutationCount();

  const offline = !browserOnline || socketState === "offline";
  const uploading = useSustained(!offline && pending > 0, 700);

  const [justSynced, setJustSynced] = useState(false);
  const wasOffline = useRef(offline);
  const wasUploading = useRef(uploading);

  useEffect(() => {
    const cameBack = wasOffline.current && !offline;
    const drained = wasUploading.current && !uploading && !offline;
    wasOffline.current = offline;
    wasUploading.current = uploading;

    if (!cameBack && !drained) return;
    setJustSynced(true);
    const timer = window.setTimeout(() => setJustSynced(false), 3_000);
    return () => window.clearTimeout(timer);
  }, [offline, uploading]);

  if (offline) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(BAR_BASE, "bg-[var(--late-soft)] text-[var(--late-ink)]")}
      >
        <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
        <span className="text-start">لا يوجد اتصال — سيتم حفظ تعديلاتك وإرسالها تلقائياً</span>
        <Link
          to="/server-setup"
          className="shrink-0 underline underline-offset-4 transition-colors duration-150 hover:text-[var(--ink)]"
        >
          عنوان الخادم
        </Link>
      </div>
    );
  }

  if (uploading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(BAR_BASE, "bg-[var(--brand-soft)] text-[var(--brand-ink)]")}
      >
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
        <span className="text-start">جارٍ رفع {pendingLabel(pending)}…</span>
      </div>
    );
  }

  if (justSynced) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(BAR_BASE, "bg-[var(--present-soft)] text-[var(--present-ink)]")}
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
        <span className="text-start">تمت المزامنة</span>
      </div>
    );
  }

  return null;
}

export default ConnectionBar;
