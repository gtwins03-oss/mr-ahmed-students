/**
 * لوحة التحكم — the first screen after signing in, and the showcase for the
 * whole design language.
 *
 * The shape of the screen, top to bottom:
 *   1. a greeting and today's Arabic date;
 *   2. four stat tiles — the signature: a quiet label, one very large number,
 *      one line of context. The attendance ratio gets a thin meter under the
 *      number instead of a donut, and nothing else in here draws a chart;
 *   3. «حصص اليوم» as a row list, each row one tap away from marking it;
 *   4. «الأقل مستوى» and «كثيرو الغياب», side by side from md up;
 *   5. «التقارير الشهرية», the one action on this page that writes anything.
 *
 * Everything is read from the single `["dashboard"]` query — this page adds no
 * requests of its own. `useAuth()` is context that the shell already mounted,
 * so the greeting costs nothing either.
 *
 * The two ranked lists are capped at five rows. When a list is longer than
 * that the card says so out loud («يُعرض ٥ من ٨») and offers «عرض الكل»: a
 * silently truncated list is a lie about how many students need attention.
 */

import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  BookOpen,
  CalendarClock,
  ChevronLeft,
  ClipboardCheck,
  Send,
  Users,
} from "lucide-react";

import { api, errorMessage } from "../api/client";
import type { DashboardData, QueueReportsResult, SessionWithRoster } from "../api/types";
import { useAuth } from "../lib/auth";
import {
  Button,
  Card,
  cn,
  EmptyState,
  Input,
  LoadingBlock,
  PageHeader,
  Section,
  StatTile,
} from "../components/ui";
import { arDate, arNum, arPercent, arTime, currentMonthISO, todayISO } from "../lib/format";

/** Ranked lists never show more than this many rows without saying so. */
const MAX_RANKED_ROWS = 5;

/* ─────────────────────────────── Arabic bits ──────────────────────────── */

/**
 * Counted nouns, Egyptian Arabic: singular, dual, the 3–10 plural, then back
 * to the singular for 11 and up. "٣ حصص" is right, "٣ حصة" is not.
 */
function counted(count: number, one: string, two: string, few: string, many: string): string {
  if (count === 1) return one;
  if (count === 2) return two;
  if (count >= 3 && count <= 10) return `${arNum(count)} ${few}`;
  return `${arNum(count)} ${many}`;
}

/** "حصة واحدة" · "حصتان" · "٣ حصص" · "١٢ حصة" */
function sessionsLabel(count: number): string {
  return counted(count, "حصة واحدة", "حصتان", "حصص", "حصة");
}

/** "غياب واحد" · "غيابان" · "٣ مرات غياب" · "١٢ مرة غياب" */
function absencesLabel(count: number): string {
  return counted(count, "غياب واحد", "غيابان", "مرات غياب", "مرة غياب");
}

/** Before noon it is صباح, after it مساء. Nothing else in here knows the time. */
function greetingFor(hour: number): string {
  return hour < 12 ? "صباح الخير" : "مساء الخير";
}

const HONORIFIC = "الأستاذ";

/**
 * Who the greeting is addressed to. The owner gets «الأستاذ» in front of his
 * name — unless he already typed it into his own account name — and an
 * assistant is greeted by name alone, because guessing an honorific for
 * somebody else's account is a good way to get the gender wrong.
 */
function greetee(name: string | undefined, isOwner: boolean): string {
  const trimmed = (name ?? "").trim();
  if (trimmed === "") return isOwner ? `${HONORIFIC} أحمد` : "";
  if (!isOwner) return trimmed;
  return trimmed.startsWith(HONORIFIC) ? trimmed : `${HONORIFIC} ${trimmed}`;
}

/* ──────────────────────────────── pieces ──────────────────────────────── */

/** A failed mutation, in a tint rather than a shout. */
function ErrorLine({ error }: { error: unknown }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-2xl border border-[var(--border)] bg-[var(--absent-soft)] px-4 py-3 text-start text-sm font-semibold leading-6 text-[var(--absent-ink)]"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{errorMessage(error)}</span>
    </p>
  );
}

/**
 * Makes a whole stat tile tappable without turning it into a second kind of
 * card: the tile keeps its own surface, the link only adds the focus ring and
 * the hover wash.
 *
 * The link — not the tile inside it — is the grid item, so any column-span
 * class belongs on `className` here.
 */
function TileLink({
  to,
  className,
  children,
}: {
  to: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "group block rounded-[20px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
        className,
      )}
    >
      {children}
    </Link>
  );
}

const TILE_HOVER = "transition-colors duration-150 group-hover:bg-[var(--surface-2)]";

interface RankedRow {
  studentId: string;
  name: string;
  /** Already formatted — a percentage, a count of absences, anything. */
  value: string;
}

/**
 * One of the two ranked lists. Capped at five rows, and honest about it: the
 * footer names both numbers and links to the full roster.
 */
function RankedList({ rows, emptyTitle }: { rows: RankedRow[]; emptyTitle: string }) {
  const shown = rows.slice(0, MAX_RANKED_ROWS);
  const capped = rows.length > shown.length;

  if (rows.length === 0) {
    return (
      <Card bodyClassName="p-0">
        <EmptyState title={emptyTitle} />
      </Card>
    );
  }

  return (
    <Card bodyClassName="p-0">
      <ul className="divide-y divide-[var(--border)]">
        {shown.map((row) => (
          <li key={row.studentId}>
            {/* The card clips its overflow, so the focus outline is pulled
                inside the row instead of being drawn around it. */}
            <Link
              to={`/students/${row.studentId}`}
              className="flex items-center gap-3 px-5 py-3 transition-colors duration-150 hover:bg-[var(--surface-2)] focus-visible:[outline-offset:-2px] sm:px-6"
            >
              <span className="min-w-0 flex-1 truncate text-start text-sm font-medium text-[var(--ink)]">
                {row.name}
              </span>
              <span className="tnum shrink-0 text-sm font-bold text-[var(--ink)]">{row.value}</span>
              <ChevronLeft className="h-4 w-4 shrink-0 text-[var(--ink-3)]" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>

      {capped && (
        <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-5 py-3 sm:px-6">
          <span className="text-start text-xs text-[var(--ink-3)]">
            يُعرض {arNum(shown.length)} من {arNum(rows.length)}
          </span>
          <Link
            to="/students"
            className="shrink-0 rounded-xl text-xs font-semibold text-[var(--brand-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            عرض الكل
          </Link>
        </div>
      )}
    </Card>
  );
}

/** One class in «حصص اليوم»: colour dot, name, time, marked counter, action. */
function SessionRow({ session }: { session: SessionWithRoster }) {
  const total = session.counts?.total ?? 0;
  const unmarked = session.counts?.unmarked ?? 0;
  const marked = Math.max(0, total - unmarked);
  const done = total > 0 && unmarked === 0;
  const subject = session.classGroup?.subject ?? "";

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-3 px-5 py-4 transition-colors duration-150 hover:bg-[var(--surface-2)] sm:px-6">
      {/* The class's own colour — an identifier, not a second accent. */}
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: session.classGroup?.color || "var(--brand)" }}
      />

      <div className="min-w-0 flex-1">
        <p className="truncate text-start text-sm font-semibold text-[var(--ink)]">
          {session.classGroup?.name ?? "مجموعة"}
        </p>
        <p className="truncate text-start text-xs text-[var(--ink-3)]">
          {subject === "" ? arTime(session.startTime) : `${subject} · ${arTime(session.startTime)}`}
        </p>
      </div>

      <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
        {total === 0 ? (
          <span className="text-start text-xs text-[var(--ink-3)]">لا طلاب في المجموعة</span>
        ) : (
          <span className="text-start text-xs text-[var(--ink-3)]">
            <span
              className={`tnum text-sm font-bold ${done ? "text-[var(--present-ink)]" : "text-[var(--ink)]"}`}
            >
              {arNum(marked)}/{arNum(total)}
            </span>{" "}
            {done ? "اكتمل التسجيل" : "تم تسجيلهم"}
          </span>
        )}

        <Link
          to="/attendance"
          className="inline-flex h-9 shrink-0 select-none items-center justify-center rounded-2xl bg-[var(--brand)] px-3.5 text-sm font-semibold text-[var(--brand-contrast)] transition-colors duration-150 hover:bg-[var(--brand-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          تسجيل الحضور
        </Link>
      </div>
    </li>
  );
}

/* ─────────────────────────────── the page ─────────────────────────────── */

export function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, isOwner } = useAuth();
  const [month, setMonth] = useState<string>(currentMonthISO());
  const [reportNotice, setReportNotice] = useState<string>("");

  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardData>("/dashboard"),
  });

  const queueReports = useMutation({
    mutationFn: (ym: string) =>
      api.post<QueueReportsResult>(`/reports/monthly/queue?month=${encodeURIComponent(ym)}`),
    onSuccess: (result) => {
      setReportNotice(`تمت إضافة ${arNum(result?.queued ?? 0)} تقرير إلى قائمة الإرسال`);
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const data = dashboard.data;
  const todaySessions = data?.todaySessions ?? [];
  const lowPerformers = data?.lowPerformers ?? [];
  const chronicAbsentees = data?.chronicAbsentees ?? [];
  const pending = data?.pendingMessages ?? 0;
  const students = data?.totals?.students ?? 0;
  const classes = data?.totals?.classes ?? 0;

  // A missing rate must not become a 0% meter, so the meter is only drawn when
  // the server actually sent a finite number.
  const rawRate = data?.weekAttendanceRate;
  const hasRate = typeof rawRate === "number" && Number.isFinite(rawRate);
  const rateMeter = hasRate ? Math.max(0, Math.min(100, rawRate)) : undefined;

  const name = greetee(user?.name, isOwner);
  const greeting = greetingFor(new Date().getHours());
  // With nobody on the roster every number below is a zero and every list is
  // empty, so the page says what to do instead of showing eight blanks.
  const rosterEmpty = students === 0;

  return (
    <div>
      <PageHeader
        title={name === "" ? greeting : `${greeting}، ${name}`}
        subtitle={arDate(todayISO())}
        actions={<Button onClick={() => navigate("/attendance")}>تسجيل حضور اليوم</Button>}
      />

      {dashboard.isLoading ? (
        <Card bodyClassName="p-0">
          <LoadingBlock label="جارٍ تحميل لوحة التحكم…" />
        </Card>
      ) : dashboard.isError ? (
        <Card bodyClassName="p-0">
          <EmptyState
            icon={<AlertCircle className="h-6 w-6" aria-hidden />}
            title="تعذّر تحميل لوحة التحكم"
            hint={errorMessage(dashboard.error)}
            action={
              <Button variant="secondary" onClick={() => void dashboard.refetch()}>
                إعادة المحاولة
              </Button>
            }
          />
        </Card>
      ) : rosterEmpty ? (
        <Card bodyClassName="p-0">
          <EmptyState
            icon={<Users className="h-6 w-6" aria-hidden />}
            title="لا يوجد طلاب بعد"
            hint={
              classes === 0
                ? "ابدأ بإضافة طلابك، ثم أنشئ المجموعات ومواعيدها — وستظهر حصص اليوم ونسب الحضور هنا تلقائياً."
                : "المجموعات جاهزة ولم يُضَف أي طالب بعد — أضف طلابك لتبدأ حصص اليوم ونسب الحضور في الظهور."
            }
            action={<Button onClick={() => navigate("/students")}>إضافة أول طالب</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {/* ── The signature row: label, one big number, one line ───────── */}
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <TileLink to="/students">
              <StatTile
                label="الطلاب"
                icon={<Users aria-hidden />}
                value={arNum(students)}
                hint="طالب نشط"
                className={TILE_HOVER}
              />
            </TileLink>

            <TileLink to="/classes">
              <StatTile
                label="المجموعات"
                icon={<BookOpen aria-hidden />}
                value={arNum(classes)}
                hint={
                  todaySessions.length === 0
                    ? "لا حصص اليوم"
                    : `${sessionsLabel(todaySessions.length)} اليوم`
                }
                className={TILE_HOVER}
              />
            </TileLink>

            <StatTile
              label="نسبة الحضور هذا الأسبوع"
              icon={<ClipboardCheck aria-hidden />}
              value={arPercent(rawRate ?? null)}
              meter={rateMeter}
              hint="متوسط الحضور خلال آخر سبعة أيام"
              className="col-span-2 sm:col-span-1"
            />

            <TileLink to="/messages" className="col-span-2 sm:col-span-1">
              <StatTile
                label="رسائل في الانتظار"
                icon={<Send aria-hidden />}
                value={arNum(pending)}
                hint={
                  pending > 0 ? "بانتظار الإرسال إلى أولياء الأمور" : "لا شيء بانتظار الإرسال"
                }
                className={cn(
                  TILE_HOVER,
                  // Waiting parents are the one thing on this page allowed to
                  // wear the accent — and it is the same accent as everything
                  // else, just filled in. Both utilities are marked important
                  // because they replace `bg-…surface` / `border-…border` that
                  // StatTile itself sets: same specificity, and Tailwind does
                  // not promise which of the two it emits last.
                  pending > 0 && "border-[var(--brand)]! bg-[var(--brand-soft)]!",
                )}
              />
            </TileLink>
          </div>

          {/* ── Today ───────────────────────────────────────────────────── */}
          <Card title="حصص اليوم" bodyClassName="p-0">
            {todaySessions.length === 0 ? (
              <EmptyState
                icon={<CalendarClock className="h-6 w-6" aria-hidden />}
                title="لا توجد حصص اليوم"
                hint="تُنشأ الحصص تلقائياً من الجدول الأسبوعي لكل مجموعة."
                action={
                  <Button variant="secondary" onClick={() => navigate("/classes")}>
                    إدارة المجموعات والمواعيد
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {todaySessions.map((session) => (
                  <SessionRow key={session.id} session={session} />
                ))}
              </ul>
            )}
          </Card>

          {/* ── Who needs attention ─────────────────────────────────────── */}
          <div className="grid gap-6 md:grid-cols-2">
            <Section
              title={
                <>
                  الأقل مستوى{" "}
                  <span className="text-xs font-normal text-[var(--ink-3)]">حسب المتوسط</span>
                </>
              }
            >
              <RankedList
                emptyTitle="لا يوجد طلاب تحت المستوى المطلوب."
                rows={lowPerformers.map((student) => ({
                  studentId: student.studentId,
                  name: student.name,
                  value: arPercent(student.averagePercentage ?? null),
                }))}
              />
            </Section>

            <Section
              title={
                <>
                  كثيرو الغياب{" "}
                  <span className="text-xs font-normal text-[var(--ink-3)]">هذا الشهر</span>
                </>
              }
            >
              <RankedList
                emptyTitle="لا توجد حالات غياب متكررة."
                rows={chronicAbsentees.map((student) => ({
                  studentId: student.studentId,
                  name: student.name,
                  value: absencesLabel(student.absentCount ?? 0),
                }))}
              />
            </Section>
          </div>

          {/* ── The one write on this page ──────────────────────────────── */}
          <Card title="التقارير الشهرية">
            <div className="space-y-4">
              <p className="text-start text-sm leading-7 text-[var(--ink-2)]">
                يُجهَّز تقرير لكل طالب نشط يتضمن حضوره ومتوسط درجاته خلال الشهر المحدد، ثم يُرسَل
                من قائمة الإرسال.
              </p>

              <div className="flex flex-wrap items-end gap-3">
                <div className="w-full sm:w-52">
                  <Input
                    label="الشهر"
                    type="month"
                    value={month}
                    onChange={(e) => setMonth(e.target.value)}
                  />
                </div>
                {/* The label is a full Arabic sentence, so the button is
                    allowed to become two lines on a narrow phone rather than
                    pushing the card sideways. `h-auto!` beats the size
                    variant's fixed height; `min-h-11` keeps the tap target. */}
                <Button
                  variant="secondary"
                  className="h-auto! min-h-11 w-full whitespace-normal py-2.5 text-center leading-6 sm:w-auto"
                  disabled={!month || queueReports.isPending}
                  onClick={() => {
                    setReportNotice("");
                    queueReports.mutate(month);
                  }}
                >
                  {queueReports.isPending
                    ? "جارٍ التجهيز…"
                    : "إضافة تقارير الشهر إلى قائمة الإرسال"}
                </Button>
              </div>

              {reportNotice !== "" && (
                <p
                  role="status"
                  className="rounded-2xl border border-[var(--border)] bg-[var(--present-soft)] px-4 py-3 text-start text-sm font-semibold leading-6 text-[var(--present-ink)]"
                >
                  {reportNotice} ·{" "}
                  <Link to="/messages" className="underline underline-offset-4">
                    فتح قائمة الإرسال
                  </Link>
                </p>
              )}

              {queueReports.isError && <ErrorLine error={queueReports.error} />}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

export default Dashboard;
