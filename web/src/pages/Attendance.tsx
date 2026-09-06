/**
 * /attendance — the screen that gets used every single day, in a hurry,
 * standing in front of a class. It is optimised harder than anything else here.
 *
 * Layout decisions that are deliberate:
 *  - The date bar is sticky. Scrolling a long roster must never cost the
 *    teacher the ability to jump to yesterday or check which day is open.
 *  - One Card per session, headed by the class colour, with the live counters
 *    as chips so the tally is readable without counting rows.
 *  - The three status buttons are 44px tall and 72px wide minimum, because they
 *    are tapped with a thumb while holding a phone in the other hand.
 *  - Every write is optimistic (see `saveMarks.onMutate`): the teacher never
 *    waits for the network mid-class, and a failed request rolls the row back.
 *
 * Colour never carries the meaning: the Arabic word — حاضر / غائب / متأخر — is
 * printed on the control in every state.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, errorMessage } from "../api/client";
import type {
  AttendanceMark,
  AttendanceStatus,
  EnsureSessionsResult,
  RosterEntry,
  SaveResult,
  SessionWithRoster,
} from "../api/types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingBlock,
  PageHeader,
  Spinner,
  cn,
} from "../components/ui";
import { STATUS_AR, addDaysISO, arDate, arNum, arTime, todayISO } from "../lib/format";

/* ─────────────────────────── status buttons ───────────────────────────── */

interface StatusOption {
  value: AttendanceStatus;
  /** Solid fill of the selected state. */
  fill: string;
  /** Ink printed on top of that fill. */
  ink: string;
}

/**
 * The three statuses that get a big button. EXCUSED stays a rare, typed-in
 * case and is only ever *shown* here, never set.
 *
 * `ink` is white for the two dark fills. --late is a bright yellow where white
 * would print «متأخر» at 1.8:1 — unreadable, and a direct breach of the rule
 * that the word is always legible — so it takes --surface instead, which is
 * the near-black card colour on dark and the highest-contrast ink the light
 * theme already ships.
 */
const OPTIONS: StatusOption[] = [
  { value: "PRESENT", fill: "var(--present)", ink: "var(--brand-contrast)" },
  { value: "ABSENT", fill: "var(--absent)", ink: "var(--brand-contrast)" },
  { value: "LATE", fill: "var(--late)", ink: "var(--surface)" },
];

/* ──────────────────────────── the date bar ────────────────────────────── */

/** «أمس / اليوم / غداً», expressed as offsets from the real today. */
const QUICK_DAYS: { label: string; offset: number }[] = [
  { label: "أمس", offset: -1 },
  { label: "اليوم", offset: 0 },
  { label: "غداً", offset: 1 },
];

/** ١ حصة · حصتان · ٣ حصص · ١١ حصة — Arabic counts a small number differently. */
function sessionCountLabel(count: number): string {
  if (count === 0) return "لا توجد حصص";
  if (count === 1) return "حصة واحدة";
  if (count === 2) return "حصتان";
  if (count <= 10) return `${arNum(count)} حصص`;
  return `${arNum(count)} حصة`;
}

/* ─────────────────────────────── helpers ──────────────────────────────── */

function tally(roster: RosterEntry[]) {
  let present = 0;
  let absent = 0;
  let late = 0;
  let excused = 0;
  for (const entry of roster) {
    if (entry.status === "PRESENT") present += 1;
    else if (entry.status === "ABSENT") absent += 1;
    else if (entry.status === "LATE") late += 1;
    else if (entry.status === "EXCUSED") excused += 1;
  }
  const total = roster.length;
  return {
    present,
    absent,
    late,
    excused,
    total,
    unmarked: total - present - absent - late - excused,
  };
}

/** The one error shape this page shows — a tinted block, never bare text. */
function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-2xl bg-[var(--absent-soft)] px-4 py-3 text-start text-sm font-semibold text-[var(--absent-ink)]"
    >
      {children}
    </p>
  );
}

/* ─────────────────────────────── the page ─────────────────────────────── */

export function Attendance() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [date, setDate] = useState<string>(todayISO());
  const [notice, setNotice] = useState<{ sessionId: string; queued: number } | null>(null);

  const sessionsKey = useMemo(() => ["sessions", date] as const, [date]);

  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: async () => {
      // The weekly schedule decides which sessions exist — materialise them first.
      await api.post<EnsureSessionsResult>(`/sessions/ensure?date=${encodeURIComponent(date)}`);
      return api.get<SessionWithRoster[]>(`/sessions?date=${encodeURIComponent(date)}`);
    },
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    setNotice(null);
  }, [date]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const saveMarks = useMutation({
    mutationFn: (vars: { sessionId: string; marks: AttendanceMark[] }) =>
      api.post<SaveResult>(`/sessions/${vars.sessionId}/attendance`, { marks: vars.marks }),
    // Optimistic: the teacher never waits for the network mid-class.
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: sessionsKey });
      const previous = queryClient.getQueryData<SessionWithRoster[]>(sessionsKey);
      queryClient.setQueryData<SessionWithRoster[]>(sessionsKey, (old) =>
        (old ?? []).map((session) => {
          if (session.id !== vars.sessionId) return session;
          return {
            ...session,
            roster: session.roster.map((entry) => {
              const mark = vars.marks.find((m) => m.studentId === entry.studentId);
              if (!mark) return entry;
              return {
                ...entry,
                status: mark.status,
                minutesLate:
                  mark.minutesLate === undefined ? entry.minutesLate : mark.minutesLate ?? null,
              };
            }),
          };
        }),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(sessionsKey, context.previous);
    },
    onSuccess: (result, vars) => {
      if (result && result.queued > 0) {
        setNotice({ sessionId: vars.sessionId, queued: result.queued });
      }
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const mark = (sessionId: string, marks: AttendanceMark[]) => {
    if (marks.length === 0) return;
    saveMarks.mutate({ sessionId, marks });
  };

  const list = sessions.data ?? [];
  const today = todayISO();
  // A background refetch keeps the previous day's list on screen, so the only
  // honest signal that something is happening is a small spinner in the bar.
  const refreshing = sessions.isFetching && !sessions.isLoading;

  return (
    <div>
      <PageHeader title="تسجيل الحضور" subtitle={arDate(date)} />

      {/* ── Sticky date bar ──────────────────────────────────────────────
          top-14 clears the mobile app header; on md+ that header is hidden
          and the bar sits flush against the top of the viewport. */}
      <div className="sticky top-14 z-20 -mt-3 bg-[var(--bg)] pb-5 pt-3 md:top-0">
        <div className="elev flex flex-wrap items-center gap-2 rounded-[20px] border border-[var(--border)] bg-[var(--surface)] p-3 sm:gap-3 sm:p-4">
          <div
            role="group"
            aria-label="اختيار اليوم"
            className="flex items-center gap-1 rounded-2xl bg-[var(--surface-2)] p-1"
          >
            {QUICK_DAYS.map(({ label, offset }) => {
              const value = addDaysISO(today, offset);
              const active = date === value;
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setDate(value)}
                  className={cn(
                    "h-9 rounded-xl px-3 text-sm font-semibold transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
                    active
                      ? "bg-[var(--brand)] text-[var(--brand-contrast)]"
                      : "text-[var(--ink-2)] hover:bg-[var(--surface-3)] hover:text-[var(--ink)]",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <input
            type="date"
            value={date}
            aria-label="تاريخ الحصص"
            onChange={(e) => setDate(e.target.value || todayISO())}
            className={cn(
              "h-11 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm font-semibold text-[var(--ink)]",
              "transition-colors duration-150 hover:border-[var(--border-strong)]",
              "focus:border-[var(--brand)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-soft)]",
            )}
          />

          <span className="ms-auto flex items-center gap-2 text-xs font-semibold text-[var(--ink-3)]">
            {refreshing && <Spinner className="h-4 w-4" />}
            {sessions.isLoading ? "جارٍ التحميل…" : sessionCountLabel(list.length)}
          </span>
        </div>
      </div>

      <div className="space-y-6">
        {saveMarks.isError ? (
          <ErrorNote>تعذّر حفظ التسجيل: {errorMessage(saveMarks.error)}</ErrorNote>
        ) : null}

        {sessions.isLoading ? (
          <Card bodyClassName="p-0">
            <LoadingBlock />
          </Card>
        ) : sessions.isError ? (
          <ErrorNote>{errorMessage(sessions.error)}</ErrorNote>
        ) : list.length === 0 ? (
          <Card bodyClassName="p-0">
            <EmptyState
              title="لا توجد حصص في هذا اليوم"
              hint="تُنشأ الحصص تلقائياً من الجدول الأسبوعي للمجموعات. أضف موعداً أسبوعياً في هذا اليوم من صفحة المجموعات ليظهر هنا."
              action={
                <Button variant="secondary" onClick={() => navigate("/classes")}>
                  إدارة المجموعات والمواعيد
                </Button>
              }
            />
          </Card>
        ) : (
          list.map((session) => {
            const roster = session.roster ?? [];
            const counts = tally(roster);
            return (
              <Card
                key={session.id}
                bodyClassName="p-0"
                title={
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: session.classGroup?.color || "var(--brand)" }}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-start text-base font-semibold text-[var(--ink)]">
                        {session.classGroup?.name ?? "مجموعة"}
                      </span>
                      <span className="block truncate text-start text-xs font-normal text-[var(--ink-3)]">
                        {session.classGroup?.subject ?? ""} · {arTime(session.startTime)}
                        {session.endTime ? ` - ${arTime(session.endTime)}` : ""}
                      </span>
                    </span>
                  </span>
                }
                actions={
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={saveMarks.isPending || roster.length === 0}
                    onClick={() =>
                      mark(
                        session.id,
                        roster.map((entry) => ({
                          studentId: entry.studentId,
                          status: "PRESENT",
                        })),
                      )
                    }
                  >
                    تحديد الكل حاضر
                  </Button>
                }
              >
                {/* Live counters. Each chip prints its own Arabic word, so the
                    tally survives being read in greyscale. */}
                <div className="flex flex-wrap items-center gap-2 px-5 pb-4 pt-3 sm:px-6">
                  <Badge tone="green">حاضر {arNum(counts.present)}</Badge>
                  <Badge tone="red">غائب {arNum(counts.absent)}</Badge>
                  <Badge tone="amber">متأخر {arNum(counts.late)}</Badge>
                  {counts.excused > 0 && <Badge tone="gray">بعذر {arNum(counts.excused)}</Badge>}
                  {counts.unmarked > 0 && (
                    <Badge tone="gray">بدون تسجيل {arNum(counts.unmarked)}</Badge>
                  )}
                </div>

                {notice && notice.sessionId === session.id ? (
                  <div className="mx-5 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[var(--brand-soft)] px-4 py-3 text-sm sm:mx-6">
                    <span className="text-[var(--ink)]">
                      تم إضافة {arNum(notice.queued)} رسالة إلى قائمة الإرسال
                    </span>
                    <Link
                      to="/messages"
                      className="font-semibold text-[var(--brand-ink)] underline underline-offset-4"
                    >
                      فتح قائمة الإرسال
                    </Link>
                  </div>
                ) : null}

                {roster.length === 0 ? (
                  <EmptyState title="لا يوجد طلاب مسجّلون في هذه المجموعة بعد." />
                ) : (
                  <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
                    {roster.map((entry) => (
                      <li
                        key={entry.studentId}
                        className="flex flex-wrap items-center gap-x-3 gap-y-2.5 px-5 py-3 transition-colors duration-150 hover:bg-[var(--surface-2)] sm:px-6"
                      >
                        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                          <Link
                            to={`/students/${entry.studentId}`}
                            className="flex min-w-0 items-center gap-2 text-start"
                          >
                            <span className="truncate text-sm font-semibold text-[var(--ink)] transition-colors duration-150 hover:text-[var(--brand-ink)]">
                              {entry.name}
                            </span>
                            {entry.status === "EXCUSED" && (
                              <Badge tone="gray">{STATUS_AR.EXCUSED}</Badge>
                            )}
                          </Link>
                          <p className="truncate text-start text-xs text-[var(--ink-3)]">
                            {entry.parentName}
                          </p>
                        </div>

                        {/* basis-full keeps this off the button row on a phone:
                            the three buttons are flex-1 (basis 0) and would
                            otherwise be squeezed past their min-content width
                            and push the row over 360px. */}
                        {entry.status === "LATE" ? (
                          <label className="flex basis-full items-center gap-2 text-xs text-[var(--ink-3)] sm:shrink-0 sm:basis-auto">
                            <span>دقائق التأخير</span>
                            <input
                              type="number"
                              inputMode="numeric"
                              dir="ltr"
                              min={0}
                              max={240}
                              defaultValue={entry.minutesLate ?? ""}
                              placeholder="٠"
                              onBlur={(e) => {
                                const raw = e.target.value.trim();
                                if (raw === "") return;
                                const minutes = Number(raw);
                                if (!Number.isFinite(minutes) || minutes < 0) return;
                                if (entry.minutesLate === minutes) return;
                                mark(session.id, [
                                  {
                                    studentId: entry.studentId,
                                    status: "LATE",
                                    minutesLate: minutes,
                                  },
                                ]);
                              }}
                              className={cn(
                                "h-11 w-16 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-2 text-center text-sm font-semibold tabular-nums text-[var(--ink)]",
                                "transition-colors duration-150 hover:border-[var(--border-strong)]",
                                "focus:border-[var(--brand)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-soft)]",
                              )}
                            />
                          </label>
                        ) : null}

                        <div className="flex flex-1 items-center gap-2 sm:flex-none">
                          {OPTIONS.map((option) => {
                            const active = entry.status === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                aria-pressed={active}
                                onClick={() => {
                                  if (active) return;
                                  mark(session.id, [
                                    { studentId: entry.studentId, status: option.value },
                                  ]);
                                }}
                                className={cn(
                                  "min-h-11 flex-1 rounded-2xl border px-3 text-sm font-bold transition-colors duration-150 sm:min-w-[4.5rem] sm:flex-none",
                                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
                                  active
                                    ? // The fill is the state; the hairline would only fight it.
                                      "border-transparent"
                                    : // Keeps its own edge when the row hover paints --surface-2 underneath it.
                                      "border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink-2)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-3)] hover:text-[var(--ink)]",
                                )}
                                style={
                                  active
                                    ? { backgroundColor: option.fill, color: option.ink }
                                    : undefined
                                }
                              >
                                {STATUS_AR[option.value]}
                              </button>
                            );
                          })}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

export default Attendance;
