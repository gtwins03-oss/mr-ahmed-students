/**
 * /messages — the outbox, and the screen the whole Tier 0 flow lives or dies on.
 *
 * Every alert the system raises lands here as a fully rendered Arabic message.
 * On the default provider (WA_LINK) sending is two taps: «فتح واتساب» opens
 * WhatsApp with the text already typed, and the row is marked sent. Nothing is
 * ever sent behind the teacher's back on that tier.
 *
 * With an autonomous provider configured (Green API / Twilio) the same rows can
 * be dispatched in place with «إرسال تلقائي», so the queue is the single place
 * that answers "did this parent hear from us?" regardless of tier.
 *
 * Visually the screen is a segmented control over a stack of message cards. The
 * message body is the point of the card, so it gets the raised --surface-2
 * block, `leading-7`, and a «عرض الكل» expander that only appears when the text
 * is actually clipped — measured, not guessed from a line count.
 */

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Inbox, RotateCw, Send } from "lucide-react";

import { api, errorMessage } from "../api/client";
import type { Message, MessageStatus, SendMessageResult, Settings } from "../api/types";
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  EmptyState,
  LoadingBlock,
  Meter,
  Modal,
  PageHeader,
  Textarea,
  cn,
} from "../components/ui";
import { MESSAGE_STATUS_AR, MESSAGE_STATUS_TONE, arDateTime, arNum } from "../lib/format";
import { isNativeApp } from "../lib/apiBase";
import { openExternal } from "../lib/openExternal";

type Tab = MessageStatus | "ALL";

const TABS: { value: Tab; label: string }[] = [
  { value: "PENDING", label: "قيد الانتظار" },
  { value: "SENT", label: "تم الإرسال" },
  { value: "FAILED", label: "فشل" },
  { value: "ALL", label: "الكل" },
];

const TEMPLATE_LABEL_AR: Record<string, string> = {
  ABSENCE: "تنبيه غياب",
  LATE: "تنبيه تأخير",
  LOW_GRADE: "تنبيه مستوى",
  MONTHLY_REPORT: "التقرير الشهري",
  CUSTOM: "رسالة مخصّصة",
};

/** Popup blockers throttle windows opened in a tight loop; a beat apart survives. */
const LINK_DELAY_MS = 800;
/** Autonomous providers need only enough spacing to stay polite to their API. */
const AUTO_DELAY_MS = 400;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/* ───────────────────────────── relative time ──────────────────────────── */

const RELATIVE = new Intl.RelativeTimeFormat("ar-EG", { numeric: "auto" });

const UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
];

/** "منذ ٥ دقائق" — the teacher cares how stale a message is, not its timestamp. */
function relativeTime(isoTimestamp: string | null | undefined): string {
  if (!isoTimestamp) return "";
  const time = new Date(isoTimestamp).getTime();
  if (Number.isNaN(time)) return "";

  const diff = time - Date.now();
  const magnitude = Math.abs(diff);
  if (magnitude < 60_000) return "الآن";

  for (const { unit, ms } of UNITS) {
    if (magnitude >= ms) return RELATIVE.format(Math.round(diff / ms), unit);
  }
  return RELATIVE.format(Math.round(diff / 60_000), "minute");
}

/* ────────────────────────────── small parts ───────────────────────────── */

type NoticeTone = "brand" | "present" | "late" | "absent";

const NOTICE_TINT: Record<NoticeTone, string> = {
  brand: "bg-[var(--brand-soft)]",
  present: "bg-[var(--present-soft)]",
  late: "bg-[var(--late-soft)]",
  absent: "bg-[var(--absent-soft)]",
};

/**
 * A tinted strip. The tint is the only colour it carries — every word inside
 * stays --ink / --ink-2, which is legible over all four tints in both themes.
 */
function Notice({
  tone = "brand",
  onDismiss,
  children,
}: {
  tone?: NoticeTone;
  onDismiss?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-2xl border border-[var(--border)] px-4 py-3",
        NOTICE_TINT[tone],
      )}
    >
      <div className="min-w-0 flex-1 text-start text-sm leading-7 text-[var(--ink)]">
        {children}
      </div>
      {onDismiss !== undefined && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-lg px-1 py-0.5 text-xs font-semibold text-[var(--ink-3)] transition-colors duration-150 hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          إخفاء
        </button>
      )}
    </div>
  );
}

/** The queue's error state — never a bare sentence on the canvas. */
function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-2xl border border-[var(--border)] bg-[var(--absent-soft)] px-4 py-3 text-start text-sm font-semibold leading-7 text-[var(--ink)]">
      {children}
    </p>
  );
}

/** The message body, clipped to a readable height until «عرض الكل». */
function MessageBody({ body }: { body: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);

  // Measured, so a two-line message never grows a pointless expander. Skipped
  // while expanded: the clamp is off then, and re-measuring would report "fits"
  // and pull the «عرض أقل» button out from under the reader.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;

    const measure = () => setClipped(el.scrollHeight - el.clientHeight > 4);
    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [body, expanded]);

  return (
    <div>
      <p
        ref={ref}
        className={cn(
          "overflow-hidden whitespace-pre-wrap rounded-2xl bg-[var(--surface-2)] p-4 text-start text-sm leading-7 text-[var(--ink)]",
          !expanded && "max-h-40",
        )}
      >
        {body}
      </p>
      {clipped && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          className="mt-2 rounded-lg text-xs font-semibold text-[var(--brand-ink)] transition-colors duration-150 hover:text-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          {expanded ? "عرض أقل" : "عرض الكل"}
        </button>
      )}
    </div>
  );
}

/* ─────────────────────────────── the page ─────────────────────────────── */

type BulkRun = { mode: "LINK" | "AUTO"; done: number; total: number; failed: number };

export function SendQueue() {
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<Tab>("PENDING");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [bulk, setBulk] = useState<BulkRun | null>(null);
  const [notice, setNotice] = useState("");
  const cancelRef = useRef(false);

  const messages = useQuery({
    queryKey: ["messages", "queue"],
    queryFn: () => api.get<Message[]>("/messages?limit=500"),
    refetchInterval: 30_000,
  });

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/settings"),
  });

  /** In the APK links go to the WhatsApp app, so the popup advice below differs. */
  const nativeShell = isNativeApp();

  /** WA_LINK is manual by design: the teacher presses Send inside WhatsApp. */
  const provider = settings.data?.provider ?? "WA_LINK";
  const manualProvider = provider !== "GREEN_API" && provider !== "TWILIO";

  const all = messages.data ?? [];

  const counts = useMemo(() => {
    const tally: Record<Tab, number> = {
      PENDING: 0,
      SENT: 0,
      FAILED: 0,
      SKIPPED: 0,
      CANCELLED: 0,
      ALL: all.length,
    };
    for (const message of all) tally[message.status] += 1;
    return tally;
  }, [all]);

  const rows = useMemo(
    () => (tab === "ALL" ? all : all.filter((message) => message.status === tab)),
    [all, tab],
  );

  const pending = useMemo(() => all.filter((message) => message.status === "PENDING"), [all]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["messages"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const markSent = useMutation({
    mutationFn: (id: string) => api.post<Message>(`/messages/${id}/mark-sent`),
    onSuccess: invalidate,
    onError: (error) => setNotice(errorMessage(error)),
  });

  const skip = useMutation({
    mutationFn: (id: string) => api.post<Message>(`/messages/${id}/skip`),
    onSuccess: invalidate,
    onError: (error) => setNotice(errorMessage(error)),
  });

  const retry = useMutation({
    mutationFn: (id: string) => api.post<Message>(`/messages/${id}/retry`),
    onSuccess: () => {
      setNotice("أُعيدت الرسالة إلى قائمة الانتظار.");
      invalidate();
    },
    onError: (error) => setNotice(errorMessage(error)),
  });

  const sendNow = useMutation({
    mutationFn: (id: string) => api.post<SendMessageResult>(`/messages/${id}/send`),
    onSuccess: (result) => {
      setNotice(
        result?.ok
          ? "تم الإرسال عبر المزوّد."
          : `تعذّر الإرسال: ${result?.error ?? "خطأ غير معروف"}`,
      );
      invalidate();
    },
    onError: (error) => setNotice(`تعذّر الإرسال: ${errorMessage(error)}`),
  });

  const editBody = useMutation({
    mutationFn: (payload: { id: string; body: string }) =>
      api.patch<Message>(`/messages/${payload.id}`, { body: payload.body }),
    onSuccess: () => {
      setEditing(null);
      setNotice("تم حفظ نص الرسالة.");
      invalidate();
    },
  });

  const busy = bulk !== null;

  const openWhatsApp = (message: Message) => {
    if (!message.waLink) {
      setNotice("لا يوجد رابط واتساب لهذه الرسالة — راجع رقم ولي الأمر في بيانات الطالب.");
      return;
    }
    void openExternal(message.waLink);
    markSent.mutate(message.id);
  };

  /**
   * Walks the pending list one message at a time. In LINK mode each wa.me URL
   * is opened and the row marked sent; in AUTO mode the provider does the work.
   * A snapshot is taken up front so a background refetch cannot shift the list
   * mid-run, and `cancelRef` lets «إيقاف» stop it between messages.
   */
  const runBulk = async (mode: BulkRun["mode"]) => {
    const queue = pending;
    if (queue.length === 0 || busy) return;

    cancelRef.current = false;
    setNotice("");
    setBulk({ mode, done: 0, total: queue.length, failed: 0 });

    let failed = 0;
    let done = 0;

    for (const message of queue) {
      if (cancelRef.current) break;

      try {
        if (mode === "LINK") {
          if (!message.waLink) throw new Error("رابط واتساب غير متاح");
          await openExternal(message.waLink);
          await api.post<Message>(`/messages/${message.id}/mark-sent`);
        } else {
          const result = await api.post<SendMessageResult>(`/messages/${message.id}/send`);
          if (!result?.ok) throw new Error(result?.error ?? "فشل الإرسال");
        }
      } catch {
        failed += 1;
      }

      done += 1;
      setBulk({ mode, done, total: queue.length, failed });
      if (done < queue.length) await sleep(mode === "LINK" ? LINK_DELAY_MS : AUTO_DELAY_MS);
    }

    setBulk(null);
    const succeeded = done - failed;
    setNotice(
      failed > 0
        ? `تمت معالجة ${arNum(succeeded)} من ${arNum(queue.length)} رسالة، وتعذّر ${arNum(
            failed,
          )} — راجع تبويب «فشل».`
        : mode === "LINK"
          ? `تم فتح ${arNum(succeeded)} رسالة وتعليمها كمُرسَلة.`
          : `تم إرسال ${arNum(succeeded)} رسالة عبر المزوّد.`,
    );
    invalidate();
  };

  return (
    <div>
      <PageHeader
        title="قائمة الإرسال"
        subtitle={
          manualProvider
            ? "اضغط «فتح واتساب» فتُفتح المحادثة والرسالة مكتوبة — ثم اضغط إرسال داخل واتساب"
            : `المزوّد النشط: ${provider} — يمكن إرسال الرسائل تلقائياً دون فتح واتساب`
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => queryClient.invalidateQueries({ queryKey: ["messages"] })}
            >
              <RotateCw className={cn("h-4 w-4", messages.isFetching && "animate-spin")} />
              تحديث
            </Button>
            {busy ? (
              <Button
                variant="danger"
                onClick={() => {
                  cancelRef.current = true;
                }}
              >
                إيقاف ({arNum(bulk.done)}/{arNum(bulk.total)})
              </Button>
            ) : (
              <>
                <Button disabled={pending.length === 0} onClick={() => void runBulk("LINK")}>
                  <Send className="h-4 w-4" />
                  إرسال الكل ({arNum(pending.length)})
                </Button>
                {!manualProvider ? (
                  <Button
                    variant="secondary"
                    disabled={pending.length === 0}
                    onClick={() => void runBulk("AUTO")}
                  >
                    إرسال الكل تلقائياً
                  </Button>
                ) : null}
              </>
            )}
          </>
        }
      />

      <div className="space-y-6">
        {/* ── Segmented control: one row, scrolls sideways on a phone ────── */}
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <div
            role="group"
            aria-label="حالة الرسائل"
            className="inline-flex gap-1 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1"
          >
            {TABS.map((entry) => {
              const active = tab === entry.value;
              return (
                <button
                  key={entry.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setTab(entry.value)}
                  className={cn(
                    "flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
                    active
                      ? "bg-[var(--brand)] text-[var(--brand-contrast)]"
                      : "text-[var(--ink-2)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]",
                  )}
                >
                  {entry.label}
                  <span
                    className={cn(
                      "tnum rounded-full px-1.5 text-xs font-bold",
                      active
                        ? "bg-[var(--brand-active)] text-[var(--brand-contrast)]"
                        : "bg-[var(--surface-2)] text-[var(--ink-3)]",
                    )}
                  >
                    {arNum(counts[entry.value])}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {notice ? (
          <Notice onDismiss={() => setNotice("")}>{notice}</Notice>
        ) : null}

        {bulk ? (
          <Card>
            <p className="mb-3 text-start text-sm font-semibold text-[var(--ink)]">
              {bulk.mode === "LINK" ? "جارٍ فتح الرسائل…" : "جارٍ الإرسال عبر المزوّد…"}{" "}
              <span className="tnum">
                {arNum(bulk.done)} من {arNum(bulk.total)}
              </span>
              {bulk.failed > 0 ? (
                <span className="text-[var(--ink-2)]"> · تعذّر {arNum(bulk.failed)}</span>
              ) : null}
            </p>
            <Meter value={bulk.done} max={bulk.total} label="تقدّم الإرسال" />
          </Card>
        ) : null}

        {tab === "PENDING" && pending.length > 0 ? (
          <Notice tone="late">
            <span className="font-bold">قبل «إرسال الكل»: </span>
            {nativeShell ? (
              <>
                يفتح التطبيق محادثة واتساب لكل رسالة بفاصل ثانية تقريباً. اضغط «إرسال» داخل
                واتساب ثم ارجع للتطبيق لتظهر الرسالة التالية — الرسائل التي لم تُفتح تبقى في
                قائمة الانتظار.
              </>
            ) : (
              <>
                يفتح المتصفح نافذة واتساب لكل رسالة بفاصل ثانية تقريباً، وغالباً سيحجب أول
                نافذتين. اسمح بالنوافذ المنبثقة لهذا الموقع من الأيقونة في شريط العنوان، ثم أعد
                المحاولة — الرسائل التي لم تُفتح تبقى في قائمة الانتظار.
              </>
            )}
          </Notice>
        ) : null}

        {messages.isLoading ? (
          <Card>
            <LoadingBlock />
          </Card>
        ) : messages.isError ? (
          <ErrorLine>{errorMessage(messages.error)}</ErrorLine>
        ) : rows.length === 0 ? (
          <Card bodyClassName="p-0">
            <EmptyState
              icon={<Inbox className="h-6 w-6" />}
              title={
                tab === "PENDING"
                  ? "لا توجد رسائل بانتظار الإرسال"
                  : tab === "FAILED"
                    ? "لا توجد رسائل فاشلة"
                    : "لا توجد رسائل"
              }
              hint={
                tab === "PENDING"
                  ? "تُضاف الرسائل هنا تلقائياً عند تسجيل غياب أو تأخير أو درجة تحت الحد، وعند إنشاء التقارير الشهرية."
                  : "ستظهر هنا الرسائل بحسب حالتها."
              }
              action={
                tab === "PENDING" ? (
                  <Link
                    to="/attendance"
                    className="inline-flex h-11 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-5 text-sm font-semibold text-[var(--ink)] transition-colors duration-150 hover:border-[var(--border-strong)] hover:bg-[var(--surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                  >
                    تسجيل الحضور
                  </Link>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <div className="space-y-4">
            {rows.map((message) => {
              const isPending = message.status === "PENDING";
              const isFailed = message.status === "FAILED";
              const isDone = message.status === "SENT";
              const stamp = isDone ? message.sentAt : message.createdAt;

              return (
                <Card key={message.id} bodyClassName="p-0">
                  {/* ── who, what, when ─────────────────────────────── */}
                  <header className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-[var(--border)] px-5 py-4 sm:px-6">
                    <div className="min-w-0 flex-1 basis-full sm:basis-0">
                      {message.studentId ? (
                        <Link
                          to={`/students/${message.studentId}`}
                          className="block truncate text-start text-base font-semibold text-[var(--ink)] transition-colors duration-150 hover:text-[var(--brand-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                        >
                          {message.studentName ?? "طالب محذوف"}
                        </Link>
                      ) : (
                        <p className="truncate text-start text-base font-semibold text-[var(--ink)]">
                          {message.studentName ?? "بدون طالب"}
                        </p>
                      )}
                      <p className="mt-1 truncate text-start text-xs text-[var(--ink-3)]">
                        ولي الأمر: {message.parentName ?? "—"} ·{" "}
                        <span dir="ltr" className="font-mono">
                          {message.toPhone}
                        </span>
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="brand">
                        {TEMPLATE_LABEL_AR[message.templateKey ?? ""] ?? "رسالة"}
                      </Badge>
                      <Badge tone={MESSAGE_STATUS_TONE[message.status]}>
                        {MESSAGE_STATUS_AR[message.status] ?? message.status}
                      </Badge>
                      <span className="text-xs text-[var(--ink-3)]" title={arDateTime(stamp)}>
                        {isDone ? "أُرسلت " : ""}
                        {relativeTime(stamp)}
                      </span>
                    </div>
                  </header>

                  {/* ── the message itself ──────────────────────────── */}
                  <div className="space-y-3 px-5 py-4 sm:px-6">
                    <MessageBody body={message.body ?? ""} />
                    {message.error ? (
                      <p className="rounded-2xl border border-[var(--border)] bg-[var(--absent-soft)] px-4 py-2.5 text-start text-xs font-semibold leading-6 text-[var(--absent-ink)]">
                        سبب الفشل: {message.error}
                      </p>
                    ) : null}
                  </div>

                  {isDone ? null : (
                    <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-5 py-4 sm:px-6">
                      {isFailed ? (
                        <Button
                          onClick={() => retry.mutate(message.id)}
                          disabled={busy || retry.isPending}
                        >
                          <RotateCw className="h-4 w-4" />
                          إعادة المحاولة
                        </Button>
                      ) : null}

                      {isPending || isFailed ? (
                        <>
                          <Button
                            variant={isFailed ? "secondary" : "primary"}
                            disabled={busy}
                            onClick={() => openWhatsApp(message)}
                          >
                            <ExternalLink className="h-4 w-4" />
                            فتح واتساب
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={busy || markSent.isPending}
                            onClick={() => markSent.mutate(message.id)}
                          >
                            تم الإرسال ✓
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="secondary"
                          disabled={busy || retry.isPending}
                          onClick={() => retry.mutate(message.id)}
                        >
                          إعادة إلى قائمة الانتظار
                        </Button>
                      )}

                      {isPending ? (
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setEditing({ id: message.id, body: message.body ?? "" })}
                        >
                          تعديل
                        </Button>
                      ) : null}

                      {!manualProvider && (isPending || isFailed) ? (
                        <Button
                          variant="secondary"
                          disabled={busy || sendNow.isPending}
                          onClick={() => sendNow.mutate(message.id)}
                        >
                          إرسال تلقائي
                        </Button>
                      ) : null}

                      {isPending || isFailed ? (
                        <span className="ms-auto">
                          <ConfirmButton
                            size="sm"
                            variant="ghost"
                            confirmLabel="تأكيد التجاهل؟"
                            disabled={busy || skip.isPending}
                            onConfirm={() => skip.mutate(message.id)}
                          >
                            تجاهل
                          </ConfirmButton>
                        </span>
                      ) : null}
                    </footer>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="تعديل نص الرسالة"
        footer={
          <>
            <Button
              disabled={editBody.isPending || !editing?.body.trim()}
              onClick={() => {
                if (!editing) return;
                editBody.mutate({ id: editing.id, body: editing.body });
              }}
            >
              {editBody.isPending ? "جارٍ الحفظ…" : "حفظ التعديل"}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              إلغاء
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="space-y-3">
            <Textarea
              label="نص الرسالة كما سيصل لولي الأمر"
              rows={12}
              value={editing.body}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            />
            <p className="text-start text-xs leading-6 text-[var(--ink-3)]">
              التعديل يخصّ هذه الرسالة فقط. لتغيير الصياغة لكل الرسائل القادمة عدّل القالب من
              صفحة الإعدادات.
            </p>
            {editBody.isError ? <ErrorLine>{errorMessage(editBody.error)}</ErrorLine> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default SendQueue;
