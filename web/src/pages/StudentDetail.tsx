/**
 * ملف الطالب — the richest screen in the app.
 *
 * Reading order, top to bottom: who this is, the numbers for the chosen
 * period, how the grades are moving, then the three logs (attendance, grades,
 * messages). The signature of the page is the size of the four numbers and the
 * single-series sparkline under them — no donuts, no gauges, no second axis.
 *
 * Data flow is untouched: the same three queries, the same keys, the same
 * preview mutation. The «تعديل» action reuses the very same PATCH /students/:id
 * that the roster screen already calls.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";

import { api } from "../api/client";
import type { Message, StudentInput, StudentReport, TemplateKey } from "../api/types";
import {
  Badge,
  Button,
  Card,
  Dot,
  EmptyState,
  Input,
  LoadingBlock,
  Meter,
  Modal,
  PageHeader,
  Section,
  Sparkline,
  StatTile,
  Textarea,
  cn,
  type SparkPoint,
  type Tone,
} from "../components/ui";
import {
  MESSAGE_STATUS_AR,
  MESSAGE_STATUS_TONE,
  STATUS_AR,
  arDateShort,
  arDateTime,
  arNum,
  arTime,
  todayISO,
} from "../lib/format";

type ClassChipData = { id: string; name: string; color?: string };

type RecentGrade = {
  id?: string;
  score?: number | null;
  note?: string | null;
  percentage?: number | string | null;
  title?: string;
  date?: string;
  maxScore?: number;
  assessment?: {
    id?: string;
    title?: string;
    date?: string;
    maxScore?: number;
    type?: string;
  } | null;
};

type RecentAttendance = {
  id?: string;
  status?: string | null;
  minutesLate?: number | null;
  note?: string | null;
  date?: string;
  session?: {
    id?: string;
    date?: string;
    startTime?: string;
    classGroup?: { name?: string; subject?: string; color?: string } | null;
  } | null;
};

type StudentDetailData = {
  id: string;
  name: string;
  parentName: string;
  parentPhone: string;
  altPhone?: string | null;
  gradeLevel: string;
  notes?: string | null;
  isActive?: boolean;
  classes?: ClassChipData[];
  report?: StudentReport | null;
  recentGrades?: RecentGrade[];
  recentAttendance?: RecentAttendance[];
};

type StudentForm = {
  name: string;
  parentName: string;
  parentPhone: string;
  altPhone: string;
  gradeLevel: string;
  notes: string;
  isActive: boolean;
};

const GRADE_SUGGESTIONS = [
  "الصف الأول الإعدادي",
  "الصف الثاني الإعدادي",
  "الصف الثالث الإعدادي",
  "الصف الأول الثانوي",
  "الصف الثاني الثانوي",
  "الصف الثالث الثانوي",
];

const TEMPLATE_AR: Record<TemplateKey, string> = {
  ABSENCE: "تنبيه غياب",
  LATE: "تنبيه تأخير",
  LOW_GRADE: "تنبيه درجة منخفضة",
  MONTHLY_REPORT: "التقرير الشهري",
  CUSTOM: "رسالة مخصصة",
};

/* ─────────────────────────────── helpers ──────────────────────────────── */

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "حدث خطأ غير متوقع";
}

function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function pctText(value: number | string | null | undefined): string {
  const n = num(value);
  if (n === null) return "—";
  return `${arNum(Math.round(n * 10) / 10)}٪`;
}

function countText(value: number | string | null | undefined): string {
  const n = num(value);
  return n === null ? "—" : arNum(n);
}

function statusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  const map = STATUS_AR as unknown as Record<string, string>;
  return map[status] ?? status;
}

/**
 * Attendance semantics, fixed: حاضر --present · غائب --absent · متأخر --late ·
 * بعذر --excused. The tone only ever accompanies the Arabic word.
 */
function statusTone(status: string | null | undefined): Tone {
  if (status === "PRESENT") return "green";
  if (status === "ABSENT") return "red";
  if (status === "LATE") return "amber";
  return "gray";
}

/** Below 60٪ is a problem, below 75٪ is a warning, above that is fine. */
function scoreTone(percentage: number): Tone {
  if (percentage < 60) return "red";
  if (percentage < 75) return "amber";
  return "green";
}

function templateLabel(key: TemplateKey | null | undefined): string {
  return key ? TEMPLATE_AR[key] : "رسالة";
}

function monthStartISO(): string {
  return `${todayISO().slice(0, 7)}-01`;
}

function waLink(phone: string, body: string): string {
  return `https://wa.me/${(phone ?? "").replace(/\D/g, "")}?text=${encodeURIComponent(body)}`;
}

/** Sends `null` for a cleared value, omits the key for one that was never set. */
function optionalField(next: string, previous?: string | null): string | null | undefined {
  const value = next.trim();
  if (value) return value;
  return previous ? null : undefined;
}

function toInput(form: StudentForm, previous: StudentDetailData): StudentInput {
  const body: StudentInput = {
    name: form.name.trim(),
    parentName: form.parentName.trim(),
    parentPhone: form.parentPhone.trim(),
    gradeLevel: form.gradeLevel.trim(),
    isActive: form.isActive,
  };
  const altPhone = optionalField(form.altPhone, previous.altPhone);
  if (altPhone !== undefined) body.altPhone = altPhone;
  const notes = optionalField(form.notes, previous.notes);
  if (notes !== undefined) body.notes = notes;
  return body;
}

/* ────────────────────────────── small pieces ──────────────────────────── */

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-2xl border border-[var(--border)] bg-[var(--absent-soft)] px-4 py-3 text-start text-sm font-semibold text-[var(--absent-ink)]">
      {children}
    </p>
  );
}

function Avatar({ name, className }: { name: string; className?: string }) {
  const letter = name.trim().charAt(0) || "؟";
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[var(--brand-soft)] text-xl font-bold text-[var(--brand-ink)]",
        className,
      )}
    >
      {letter}
    </span>
  );
}

/**
 * A stored class colour reaches CSS as an inline style, so it is checked before
 * it gets there: anything that is not a plain 6-digit hex falls back to the
 * brand accent rather than silently painting `transparent`.
 */
const HEX6 = /^#[0-9a-fA-F]{6}$/;

function chipColor(color?: string): string {
  return HEX6.test(color ?? "") ? (color as string) : "var(--brand)";
}

/** The same colour at 18% (0x2e), which is a tint every engine understands. */
function chipTint(color?: string): string {
  return HEX6.test(color ?? "") ? `${color}2e` : "var(--brand-soft)";
}

/** The class colour is data; it tints the chip and marks the dot, never more. */
function ClassChip({ name, color }: { name: string; color?: string }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold text-[var(--ink)]"
      style={{ backgroundColor: chipTint(color) }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: chipColor(color) }}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-start text-xs font-semibold text-[var(--ink-3)]">{label}</p>
      <div className="mt-1 text-start text-sm text-[var(--ink)]">{children}</div>
    </div>
  );
}

/** One line of the attendance breakdown: dot, word, count, thin meter. */
function BreakdownRow({
  tone,
  label,
  count,
  total,
}: {
  tone: Tone;
  label: string;
  count: number;
  total: number;
}) {
  return (
    <li className="space-y-2">
      <div className="flex items-center gap-2">
        <Dot tone={tone} />
        <span className="flex-1 text-start text-sm text-[var(--ink-2)]">{label}</span>
        <span className="text-sm font-bold tabular-nums text-[var(--ink)]">{arNum(count)}</span>
      </div>
      <Meter value={count} max={total > 0 ? total : 100} tone={tone} label={label} />
    </li>
  );
}

function CheckToggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex min-h-[46px] cursor-pointer select-none items-center gap-2.5 self-end rounded-2xl border px-4 text-sm font-semibold transition-colors duration-150",
        checked
          ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-ink)]"
          : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink-2)] hover:border-[var(--border-strong)]",
      )}
    >
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0 accent-[var(--brand)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-start">{children}</span>
    </label>
  );
}

/* ─────────────────────────────── the page ─────────────────────────────── */

export function StudentDetail() {
  const params = useParams();
  const id = params.id ?? "";
  const queryClient = useQueryClient();
  const [from, setFrom] = useState<string>(monthStartISO());
  const [to, setTo] = useState<string>(todayISO());
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBody, setPreviewBody] = useState("");
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState<StudentForm | null>(null);
  const [formError, setFormError] = useState("");

  const student = useQuery({
    queryKey: ["student", id],
    queryFn: () => api.get<StudentDetailData>(`/students/${id}`),
    enabled: id !== "",
  });

  const report = useQuery({
    queryKey: ["student-report", id, from, to],
    queryFn: () =>
      api.get<StudentReport>(
        `/students/${id}/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
    enabled: id !== "" && from !== "" && to !== "",
  });

  const messages = useQuery({
    queryKey: ["messages", "student", id],
    queryFn: () => api.get<Message[]>(`/messages?studentId=${encodeURIComponent(id)}`),
    enabled: id !== "",
  });

  const preview = useMutation({
    mutationFn: () =>
      api.post<{ body: string }>("/messages/preview", {
        templateKey: "MONTHLY_REPORT",
        studentId: id,
      }),
    onSuccess: (res) => {
      setPreviewBody(res?.body ?? "");
      setCopied(false);
      setPreviewOpen(true);
    },
  });

  const save = useMutation({
    mutationFn: (body: StudentInput) => api.patch<StudentDetailData>(`/students/${id}`, body),
    onSuccess: () => {
      setForm(null);
      setFormError("");
      queryClient.invalidateQueries({ queryKey: ["student", id] });
      queryClient.invalidateQueries({ queryKey: ["students"] });
      queryClient.invalidateQueries({ queryKey: ["classes"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (error) => setFormError(errorText(error)),
  });

  const data = student.data;
  const stats = (report.data ?? data?.report ?? null) as StudentReport | null;
  const grades = useMemo<RecentGrade[]>(() => data?.recentGrades ?? [], [data]);
  const attendance = data?.recentAttendance ?? [];
  const history = messages.data ?? [];

  const chips = useMemo<ClassChipData[]>(() => data?.classes ?? [], [data]);

  /**
   * The trend series: oldest → newest, percentages only. Entries the student
   * never sat carry no percentage and are dropped rather than plotted as zero.
   */
  const trend = useMemo<SparkPoint[]>(() => {
    const points = grades
      .map((g) => {
        const label = g.assessment?.title ?? g.title ?? "اختبار";
        const date = (g.assessment?.date ?? g.date ?? "").slice(0, 10);
        const maxScore = g.assessment?.maxScore ?? g.maxScore;
        const score = num(g.score);
        const computed =
          score !== null && maxScore && maxScore > 0 ? (score / maxScore) * 100 : null;
        const value = num(g.percentage) ?? computed;
        return value === null ? null : { label, value, date };
      })
      .filter((p): p is { label: string; value: number; date: string } => p !== null);

    points.sort((a, b) => a.date.localeCompare(b.date));
    return points.map(({ label, value, date }) => ({
      label,
      value,
      hint: date ? arDateShort(date) : undefined,
    }));
  }, [grades]);

  const openEdit = () => {
    if (!data) return;
    setFormError("");
    setForm({
      name: data.name ?? "",
      parentName: data.parentName ?? "",
      parentPhone: data.parentPhone ?? "",
      altPhone: data.altPhone ?? "",
      gradeLevel: data.gradeLevel ?? "",
      notes: data.notes ?? "",
      isActive: data.isActive !== false,
    });
  };

  const submit = () => {
    if (!form || !data) return;
    if (!form.name.trim() || !form.parentName.trim() || !form.parentPhone.trim()) {
      setFormError("اسم الطالب واسم ولي الأمر ورقم الهاتف حقول مطلوبة.");
      return;
    }
    if (!form.gradeLevel.trim()) {
      setFormError("المرحلة الدراسية مطلوبة.");
      return;
    }
    setFormError("");
    save.mutate(toInput(form, data));
  };

  if (!id) {
    return <ErrorNote>لم يتم تحديد الطالب.</ErrorNote>;
  }

  /* Every number below is read through `num`, so a missing column renders as
     "—" and a zero denominator never reaches a division. */
  const sessionsTotal = num(stats?.sessionsTotal) ?? 0;
  const presentCount = num(stats?.presentCount) ?? 0;
  const absentCount = num(stats?.absentCount) ?? 0;
  const lateCount = num(stats?.lateCount) ?? 0;
  const assessmentsCount = num(stats?.assessmentsCount) ?? 0;
  const attendanceRate = num(stats?.attendanceRate);
  const averagePercentage = num(stats?.averagePercentage);

  return (
    <div className="space-y-6">
      <Link
        to="/students"
        className="inline-flex items-center gap-1.5 rounded-2xl text-sm font-semibold text-[var(--ink-2)] transition-colors duration-150 hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
      >
        <ArrowRight className="h-4 w-4" aria-hidden />
        رجوع للقائمة
      </Link>

      {student.isLoading ? (
        <>
          <PageHeader title="ملف الطالب" />
          <Card bodyClassName="p-0">
            <LoadingBlock label="جارٍ تحميل ملف الطالب…" />
          </Card>
        </>
      ) : student.isError ? (
        <>
          <PageHeader title="ملف الطالب" />
          <ErrorNote>{errorText(student.error)}</ErrorNote>
        </>
      ) : !data ? (
        <>
          <PageHeader title="ملف الطالب" />
          <Card bodyClassName="p-0">
            <EmptyState title="الطالب غير موجود" hint="ربما تم حذفه من القائمة." />
          </Card>
        </>
      ) : (
        <>
          {/* ── header ──────────────────────────────────────────────────── */}
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-1 items-start gap-4">
              <Avatar name={data.name} />
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-start text-2xl font-bold tracking-tight text-[var(--ink)]">
                    {data.name}
                  </h1>
                  {data.isActive === false ? <Badge tone="gray">غير نشط</Badge> : null}
                </div>
                <p className="text-start text-sm text-[var(--ink-2)]">{data.gradeLevel}</p>
                {chips.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {chips.map((c) => (
                      <ClassChip key={c.id} name={c.name} color={c.color} />
                    ))}
                  </div>
                ) : (
                  <p className="text-start text-xs text-[var(--ink-3)]">غير مسجّل في أي مجموعة</p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => preview.mutate()} disabled={preview.isPending}>
                {preview.isPending ? "جارٍ التجهيز…" : "إرسال تقرير"}
              </Button>
              <Button variant="secondary" onClick={openEdit}>
                تعديل
              </Button>
            </div>
          </header>

          {preview.isError ? <ErrorNote>{errorText(preview.error)}</ErrorNote> : null}

          {/* ── who this is ─────────────────────────────────────────────── */}
          <Card title="بيانات الطالب">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="ولي الأمر">{data.parentName}</Field>
              <Field label="هاتف ولي الأمر">
                <span dir="ltr" className="block tabular-nums">
                  {data.parentPhone}
                </span>
              </Field>
              {data.altPhone ? (
                <Field label="رقم بديل">
                  <span dir="ltr" className="block tabular-nums">
                    {data.altPhone}
                  </span>
                </Field>
              ) : null}
            </div>
            {data.notes ? (
              <p className="mt-4 whitespace-pre-wrap rounded-2xl bg-[var(--surface-2)] p-4 text-start text-sm leading-7 text-[var(--ink-2)]">
                {data.notes}
              </p>
            ) : null}
          </Card>

          {/* ── the numbers ─────────────────────────────────────────────── */}
          <Section title="ملخص الفترة">
            <div className="space-y-4">
              <Card>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,12rem)_auto] sm:items-end">
                  <Input
                    label="من"
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                  <Input label="إلى" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                  {report.isFetching ? (
                    <span className="self-end pb-3 text-start text-xs text-[var(--ink-3)]">
                      جارٍ التحديث…
                    </span>
                  ) : null}
                </div>
              </Card>

              {report.isError ? <ErrorNote>{errorText(report.error)}</ErrorNote> : null}

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatTile
                  label="نسبة الحضور"
                  value={pctText(attendanceRate)}
                  meter={attendanceRate ?? undefined}
                  hint={
                    sessionsTotal > 0
                      ? `من ${arNum(sessionsTotal)} حصة`
                      : "لا توجد حصص في هذه الفترة"
                  }
                />
                <StatTile
                  label="المتوسط العام"
                  value={pctText(averagePercentage)}
                  meter={averagePercentage ?? undefined}
                  hint={
                    assessmentsCount > 0
                      ? `أعلى ${pctText(stats?.bestPercentage)} · أقل ${pctText(stats?.worstPercentage)}`
                      : "لا توجد اختبارات في هذه الفترة"
                  }
                />
                <StatTile
                  label="عدد الحصص"
                  value={countText(stats?.sessionsTotal)}
                  hint={`حاضر ${arNum(presentCount)} · غائب ${arNum(absentCount)}`}
                />
                <StatTile
                  label="عدد الاختبارات"
                  value={countText(stats?.assessmentsCount)}
                  hint="خلال الفترة المحددة"
                />
              </div>

              <Card title="تفصيل الحضور">
                {sessionsTotal === 0 ? (
                  <p className="text-start text-sm text-[var(--ink-2)]">
                    لا توجد حصص مسجّلة في هذه الفترة.
                  </p>
                ) : (
                  <ul className="grid gap-4 sm:grid-cols-3">
                    <BreakdownRow
                      tone="green"
                      label="حاضر"
                      count={presentCount}
                      total={sessionsTotal}
                    />
                    <BreakdownRow
                      tone="red"
                      label="غائب"
                      count={absentCount}
                      total={sessionsTotal}
                    />
                    <BreakdownRow
                      tone="amber"
                      label="متأخر"
                      count={lateCount}
                      total={sessionsTotal}
                    />
                  </ul>
                )}
              </Card>
            </div>
          </Section>

          {/* ── the trend ───────────────────────────────────────────────── */}
          <Card title="تطور الدرجات">
            <Sparkline
              points={trend}
              formatValue={(value) => pctText(value)}
              emptyTitle="لا يوجد منحنى بعد"
              emptyHint="يظهر المنحنى بعد تسجيل درجتين على الأقل لهذا الطالب."
            />
          </Card>

          {/* ── the logs ────────────────────────────────────────────────── */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="الدرجات" bodyClassName="px-5 pb-2 pt-1 sm:px-6">
              {grades.length === 0 ? (
                <p className="py-4 text-start text-sm text-[var(--ink-2)]">
                  لا توجد درجات مسجّلة بعد.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {grades.map((g, index) => {
                    const title = g.assessment?.title ?? g.title ?? "اختبار";
                    const date = g.assessment?.date ?? g.date;
                    const maxScore = g.assessment?.maxScore ?? g.maxScore;
                    const score = num(g.score);
                    const computed =
                      score !== null && maxScore && maxScore > 0 ? (score / maxScore) * 100 : null;
                    const percentage = num(g.percentage) ?? computed;
                    return (
                      <li
                        key={g.id ?? `${title}-${index}`}
                        className="flex items-center gap-3 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-start text-sm font-semibold text-[var(--ink)]">
                            {title}
                          </p>
                          <p className="text-start text-xs text-[var(--ink-3)]">
                            {date ? arDateShort(date) : "—"}
                          </p>
                        </div>
                        <span className="shrink-0 text-sm tabular-nums text-[var(--ink-2)]">
                          {score === null
                            ? "لم يؤدِّ الاختبار"
                            : `${arNum(score)} / ${arNum(maxScore ?? 0)}`}
                        </span>
                        {percentage === null ? null : (
                          <Badge tone={scoreTone(percentage)} className="shrink-0">
                            {pctText(percentage)}
                          </Badge>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card title="آخر الحضور" bodyClassName="px-5 pb-2 pt-1 sm:px-6">
              {attendance.length === 0 ? (
                <p className="py-4 text-start text-sm text-[var(--ink-2)]">
                  لا يوجد سجل حضور بعد.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {attendance.map((a, index) => {
                    const date = a.session?.date ?? a.date;
                    const className = a.session?.classGroup?.name;
                    return (
                      <li
                        key={a.id ?? `${date}-${index}`}
                        className="flex items-center gap-3 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-start text-sm font-semibold text-[var(--ink)]">
                            {date ? arDateShort(date) : "—"}
                          </p>
                          <p className="truncate text-start text-xs text-[var(--ink-3)]">
                            {className ?? ""}
                            {a.session?.startTime ? ` · ${arTime(a.session.startTime)}` : ""}
                          </p>
                        </div>
                        {a.status === "LATE" && a.minutesLate ? (
                          <span className="shrink-0 text-xs tabular-nums text-[var(--ink-3)]">
                            {arNum(a.minutesLate)} دقيقة
                          </span>
                        ) : null}
                        <Badge tone={statusTone(a.status)} className="shrink-0">
                          {statusLabel(a.status)}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          <Card
            title="سجل الرسائل"
            actions={
              <Link
                to="/messages"
                className="inline-flex h-9 select-none items-center rounded-2xl px-3 text-sm font-semibold text-[var(--brand-ink)] transition-colors duration-150 hover:bg-[var(--brand-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                قائمة الإرسال
              </Link>
            }
            bodyClassName="px-5 pb-2 pt-1 sm:px-6"
          >
            {messages.isLoading ? (
              <LoadingBlock label="جارٍ تحميل الرسائل…" />
            ) : messages.isError ? (
              <div className="py-3">
                <ErrorNote>{errorText(messages.error)}</ErrorNote>
              </div>
            ) : history.length === 0 ? (
              <p className="py-4 text-start text-sm text-[var(--ink-2)]">
                لم تُرسَل أي رسائل لهذا الطالب بعد.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {history.map((m) => (
                  <li key={m.id} className="py-3">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-start text-sm font-semibold text-[var(--ink)]">
                          {templateLabel(m.templateKey)}
                        </p>
                        <p className="text-start text-xs text-[var(--ink-3)]">
                          {arDateTime(m.createdAt)}
                        </p>
                      </div>
                      {/* Defensive lookups: `status` is typed, but it comes off
                          the wire and an unknown value must not print nothing. */}
                      <Badge tone={MESSAGE_STATUS_TONE[m.status] ?? "gray"} className="shrink-0">
                        {MESSAGE_STATUS_AR[m.status] ?? "—"}
                      </Badge>
                    </div>
                    <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap text-start text-sm text-[var(--ink-2)]">
                      {m.body}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {/* ── report preview ──────────────────────────────────────────────── */}
      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="معاينة التقرير"
        footer={
          <>
            <Button
              disabled={!data || !previewBody}
              onClick={() => {
                if (!data || !previewBody) return;
                window.open(waLink(data.parentPhone, previewBody), "_blank");
              }}
            >
              فتح واتساب
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (navigator.clipboard) {
                  void navigator.clipboard.writeText(previewBody);
                  setCopied(true);
                }
              }}
            >
              {copied ? "تم النسخ" : "نسخ النص"}
            </Button>
            <Button variant="ghost" onClick={() => setPreviewOpen(false)}>
              إغلاق
            </Button>
          </>
        }
      >
        <p className="whitespace-pre-wrap rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-start text-sm leading-7 text-[var(--ink)]">
          {previewBody || "لا يوجد نص للمعاينة."}
        </p>
      </Modal>

      {/* ── edit ────────────────────────────────────────────────────────── */}
      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title="تعديل بيانات الطالب"
        footer={
          <>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
            <Button variant="ghost" onClick={() => setForm(null)}>
              إلغاء
            </Button>
          </>
        }
      >
        {form ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="اسم الطالب"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <Input
                label="المرحلة الدراسية"
                list="student-grade-levels"
                value={form.gradeLevel}
                onChange={(e) => setForm({ ...form, gradeLevel: e.target.value })}
              />
              <Input
                label="اسم ولي الأمر"
                value={form.parentName}
                onChange={(e) => setForm({ ...form, parentName: e.target.value })}
              />
              <Input
                label="هاتف ولي الأمر"
                dir="ltr"
                inputMode="tel"
                placeholder="01001234567"
                className="tabular-nums"
                value={form.parentPhone}
                onChange={(e) => setForm({ ...form, parentPhone: e.target.value })}
              />
              <Input
                label="رقم بديل (اختياري)"
                dir="ltr"
                inputMode="tel"
                className="tabular-nums"
                value={form.altPhone}
                onChange={(e) => setForm({ ...form, altPhone: e.target.value })}
              />
              <CheckToggle
                checked={form.isActive}
                onChange={(next) => setForm({ ...form, isActive: next })}
              >
                طالب نشط
              </CheckToggle>
            </div>

            <datalist id="student-grade-levels">
              {GRADE_SUGGESTIONS.map((grade) => (
                <option key={grade} value={grade} />
              ))}
            </datalist>

            <Textarea
              label="ملاحظات"
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />

            {formError ? <ErrorNote>{formError}</ErrorNote> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default StudentDetail;
