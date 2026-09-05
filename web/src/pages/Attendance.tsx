import { useEffect, useMemo, useState } from "react";
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
import { Button, Card, EmptyState, LoadingBlock, PageHeader } from "../components/ui";
import { STATUS_AR, addDaysISO, arDate, arNum, arTime, isToday, todayISO } from "../lib/format";

/** The three statuses that get a big button. EXCUSED stays a rare, typed-in case. */
const OPTIONS: { value: AttendanceStatus; on: string; off: string }[] = [
  {
    value: "PRESENT",
    on: "bg-emerald-600 text-white shadow-sm",
    off: "bg-slate-100 text-slate-700 hover:bg-emerald-50 hover:text-emerald-800",
  },
  {
    value: "ABSENT",
    on: "bg-rose-600 text-white shadow-sm",
    off: "bg-slate-100 text-slate-700 hover:bg-rose-50 hover:text-rose-800",
  },
  {
    value: "LATE",
    on: "bg-amber-500 text-white shadow-sm",
    off: "bg-slate-100 text-slate-700 hover:bg-amber-50 hover:text-amber-800",
  },
];

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
      await api.post<EnsureSessionsResult>(
        `/sessions/ensure?date=${encodeURIComponent(date)}`,
      );
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

  return (
    <div>
      <PageHeader
        title="تسجيل الحضور"
        subtitle={arDate(date)}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDate((current) => addDaysISO(current, -1))}
            >
              ‹ السابق
            </Button>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value || todayISO())}
              className="h-9 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDate((current) => addDaysISO(current, 1))}
            >
              التالي ›
            </Button>
            <Button
              variant={isToday(date) ? "primary" : "ghost"}
              size="sm"
              onClick={() => setDate(todayISO())}
            >
              اليوم
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        {saveMarks.isError ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
            تعذّر حفظ التسجيل: {errorMessage(saveMarks.error)}
          </p>
        ) : null}

        {sessions.isLoading ? (
          <LoadingBlock />
        ) : sessions.isError ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
            {errorMessage(sessions.error)}
          </p>
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
                  <span className="flex items-center gap-3">
                    <span
                      className="h-9 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: session.classGroup?.color ?? "#2563eb" }}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-base font-bold text-slate-900">
                        {session.classGroup?.name ?? "مجموعة"}
                      </span>
                      <span className="block truncate text-sm font-normal text-slate-500">
                        {session.classGroup?.subject ?? ""} · {arTime(session.startTime)}
                        {session.endTime ? ` - ${arTime(session.endTime)}` : ""}
                      </span>
                    </span>
                  </span>
                }
                actions={
                  <>
                    <span className="hidden items-center gap-2 text-sm font-semibold tabular-nums sm:flex">
                      <span className="text-emerald-700">حاضر {arNum(counts.present)}</span>
                      <span className="text-slate-300">·</span>
                      <span className="text-rose-700">غائب {arNum(counts.absent)}</span>
                      <span className="text-slate-300">·</span>
                      <span className="text-amber-600">متأخر {arNum(counts.late)}</span>
                      {counts.unmarked > 0 ? (
                        <>
                          <span className="text-slate-300">·</span>
                          <span className="text-slate-500">
                            بدون تسجيل {arNum(counts.unmarked)}
                          </span>
                        </>
                      ) : null}
                    </span>
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
                  </>
                }
              >
                <p className="flex items-center gap-2 border-b border-slate-100 px-4 py-2 text-sm font-semibold tabular-nums sm:hidden">
                  <span className="text-emerald-700">حاضر {arNum(counts.present)}</span>
                  <span className="text-slate-300">·</span>
                  <span className="text-rose-700">غائب {arNum(counts.absent)}</span>
                  <span className="text-slate-300">·</span>
                  <span className="text-amber-600">متأخر {arNum(counts.late)}</span>
                </p>

                {notice && notice.sessionId === session.id ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-100 bg-emerald-50 px-4 py-2.5 text-sm font-medium text-emerald-800">
                    <span>تم إضافة {arNum(notice.queued)} رسالة إلى قائمة الإرسال</span>
                    <Link to="/messages" className="font-bold underline underline-offset-4">
                      فتح قائمة الإرسال
                    </Link>
                  </div>
                ) : null}

                {roster.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-slate-500">
                    لا يوجد طلاب مسجّلون في هذه المجموعة بعد.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {roster.map((entry) => (
                      <li
                        key={entry.studentId}
                        className={`flex flex-wrap items-center gap-3 px-4 py-3 ${
                          entry.status ? "bg-white" : "bg-amber-50/40"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <Link
                            to={`/students/${entry.studentId}`}
                            className="block truncate text-base font-semibold text-slate-900 hover:text-blue-700"
                          >
                            {entry.name}
                          </Link>
                          <p className="truncate text-sm text-slate-500">{entry.parentName}</p>
                        </div>

                        {entry.status === "LATE" ? (
                          <label className="flex items-center gap-2 text-sm text-slate-600">
                            <span>دقائق التأخير</span>
                            <input
                              type="number"
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
                              className="w-20 rounded-xl border border-slate-300 px-2 py-1.5 text-center text-sm tabular-nums shadow-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                            />
                          </label>
                        ) : null}

                        <div className="flex gap-2">
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
                                className={`min-w-[4.75rem] rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${
                                  active ? option.on : option.off
                                }`}
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
