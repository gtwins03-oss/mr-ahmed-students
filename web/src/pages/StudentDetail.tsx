import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Message, StudentReport } from "../api/types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Spinner,
} from "../components/ui";
import { STATUS_AR, arDateShort, arNum, arTime, todayISO } from "../lib/format";

type ClassChip = { id: string; name: string; color?: string };

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
  classes?: ClassChip[];
  report?: StudentReport | null;
  recentGrades?: RecentGrade[];
  recentAttendance?: RecentAttendance[];
};

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

function statusTone(status: string | null | undefined): "green" | "red" | "amber" | "blue" | "gray" {
  if (status === "PRESENT") return "green";
  if (status === "ABSENT") return "red";
  if (status === "LATE") return "amber";
  if (status === "EXCUSED") return "blue";
  return "gray";
}

function messageTone(status: string | null | undefined): "green" | "red" | "amber" | "blue" | "gray" {
  if (status === "SENT") return "green";
  if (status === "FAILED") return "red";
  if (status === "PENDING") return "amber";
  return "gray";
}

const MESSAGE_STATUS_AR: Record<string, string> = {
  PENDING: "قيد الانتظار",
  SENT: "تم الإرسال",
  FAILED: "فشل",
  SKIPPED: "تم التجاهل",
  CANCELLED: "ملغاة",
};

function monthStartISO(): string {
  return `${todayISO().slice(0, 7)}-01`;
}

function waLink(phone: string, body: string): string {
  return `https://wa.me/${(phone ?? "").replace(/\D/g, "")}?text=${encodeURIComponent(body)}`;
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold tabular-nums ${tone ?? "text-slate-900"}`}>
        {value}
      </p>
    </div>
  );
}

export function StudentDetail() {
  const params = useParams();
  const id = params.id ?? "";
  const [from, setFrom] = useState<string>(monthStartISO());
  const [to, setTo] = useState<string>(todayISO());
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBody, setPreviewBody] = useState("");
  const [copied, setCopied] = useState(false);

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

  const data = student.data;
  const stats = (report.data ?? data?.report ?? null) as StudentReport | null;
  const grades = data?.recentGrades ?? [];
  const attendance = data?.recentAttendance ?? [];
  const history = messages.data ?? [];

  const chips = useMemo<ClassChip[]>(() => data?.classes ?? [], [data]);

  if (!id) {
    return <p className="text-sm text-rose-700">لم يتم تحديد الطالب.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title={data?.name ?? "ملف الطالب"}
          subtitle={data ? `${data.gradeLevel} · ولي الأمر: ${data.parentName}` : undefined}
        />
        <div className="flex items-center gap-2">
          <Link
            to="/students"
            className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-100"
          >
            رجوع للقائمة
          </Link>
          <Button onClick={() => preview.mutate()} disabled={preview.isPending || !data}>
            {preview.isPending ? "جارٍ التجهيز…" : "إرسال تقرير"}
          </Button>
        </div>
      </div>

      {student.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : student.isError ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {errorText(student.error)}
        </p>
      ) : !data ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <EmptyState title="الطالب غير موجود" hint="ربما تم حذفه من القائمة." />
        </div>
      ) : (
        <>
          <Card title="بيانات الطالب">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs text-slate-500">هاتف ولي الأمر</p>
                <p dir="ltr" className="font-mono text-slate-800">
                  {data.parentPhone}
                </p>
              </div>
              {data.altPhone ? (
                <div>
                  <p className="text-xs text-slate-500">رقم بديل</p>
                  <p dir="ltr" className="font-mono text-slate-800">
                    {data.altPhone}
                  </p>
                </div>
              ) : null}
              <div>
                <p className="text-xs text-slate-500">الحالة</p>
                <p className="text-slate-800">
                  {data.isActive === false ? (
                    <Badge tone="gray">غير نشط</Badge>
                  ) : (
                    <Badge tone="green">نشط</Badge>
                  )}
                </p>
              </div>
              <div className="sm:col-span-2 lg:col-span-1">
                <p className="text-xs text-slate-500">المجموعات</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {chips.length === 0 ? (
                    <span className="text-sm text-slate-400">لا يوجد</span>
                  ) : (
                    chips.map((c) => (
                      <span
                        key={c.id}
                        className="rounded-full px-2.5 py-1 text-xs font-semibold text-white"
                        style={{ backgroundColor: c.color || "#2563eb" }}
                      >
                        {c.name}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>
            {data.notes ? (
              <p className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                {data.notes}
              </p>
            ) : null}
          </Card>

          <Card title="التقرير">
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <div className="w-44">
                <Input label="من" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="w-44">
                <Input label="إلى" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
              {report.isFetching ? <span className="pb-2 text-sm text-slate-500">…تحديث</span> : null}
            </div>

            {report.isError ? (
              <p className="mb-3 text-sm font-medium text-rose-700">{errorText(report.error)}</p>
            ) : null}

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
              <Tile
                label="نسبة الحضور"
                value={pctText(stats?.attendanceRate)}
                tone="text-emerald-700"
              />
              <Tile label="عدد الحصص" value={countText(stats?.sessionsTotal)} />
              <Tile label="حضور" value={countText(stats?.presentCount)} tone="text-emerald-700" />
              <Tile label="غياب" value={countText(stats?.absentCount)} tone="text-rose-700" />
              <Tile label="تأخير" value={countText(stats?.lateCount)} tone="text-amber-600" />
              <Tile label="عدد الاختبارات" value={countText(stats?.assessmentsCount)} />
              <Tile label="المتوسط العام" value={pctText(stats?.averagePercentage)} tone="text-blue-700" />
              <Tile label="أعلى درجة" value={pctText(stats?.bestPercentage)} tone="text-emerald-700" />
              <Tile label="أقل درجة" value={pctText(stats?.worstPercentage)} tone="text-rose-700" />
            </div>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="آخر الدرجات">
              {grades.length === 0 ? (
                <p className="py-2 text-sm text-slate-500">لا توجد درجات مسجّلة بعد.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {grades.map((g, index) => {
                    const title = g.assessment?.title ?? g.title ?? "اختبار";
                    const date = g.assessment?.date ?? g.date;
                    const maxScore = g.assessment?.maxScore ?? g.maxScore;
                    const score = num(g.score);
                    const computed =
                      score !== null && maxScore && maxScore > 0 ? (score / maxScore) * 100 : null;
                    const percentage = num(g.percentage) ?? computed;
                    return (
                      <li key={g.id ?? `${title}-${index}`} className="flex items-center gap-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-slate-800">{title}</p>
                          <p className="text-xs text-slate-500">{date ? arDateShort(date) : ""}</p>
                        </div>
                        <span className="text-sm text-slate-600 tabular-nums">
                          {score === null ? "لم يؤدِّ الاختبار" : `${arNum(score)} / ${arNum(maxScore ?? 0)}`}
                        </span>
                        {percentage === null ? null : (
                          <Badge tone={percentage < 60 ? "red" : percentage < 75 ? "amber" : "green"}>
                            {pctText(percentage)}
                          </Badge>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card title="آخر الحضور">
              {attendance.length === 0 ? (
                <p className="py-2 text-sm text-slate-500">لا يوجد سجل حضور بعد.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {attendance.map((a, index) => {
                    const date = a.session?.date ?? a.date;
                    const className = a.session?.classGroup?.name;
                    return (
                      <li key={a.id ?? `${date}-${index}`} className="flex items-center gap-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-slate-800">
                            {date ? arDateShort(date) : "—"}
                          </p>
                          <p className="truncate text-xs text-slate-500">
                            {className ?? ""}
                            {a.session?.startTime ? ` · ${arTime(a.session.startTime)}` : ""}
                          </p>
                        </div>
                        {a.status === "LATE" && a.minutesLate ? (
                          <span className="text-xs text-slate-500">
                            {arNum(a.minutesLate)} دقيقة
                          </span>
                        ) : null}
                        <Badge tone={statusTone(a.status)}>{statusLabel(a.status)}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          <Card title="سجل الرسائل">
            {messages.isLoading ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : messages.isError ? (
              <p className="text-sm font-medium text-rose-700">{errorText(messages.error)}</p>
            ) : history.length === 0 ? (
              <p className="py-2 text-sm text-slate-500">لم تُرسَل أي رسائل لهذا الطالب بعد.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {history.map((m) => (
                  <li key={m.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={messageTone(m.status)}>
                        {MESSAGE_STATUS_AR[m.status ?? ""] ?? m.status ?? "—"}
                      </Badge>
                      <span className="text-xs text-slate-500">
                        {m.createdAt ? arDateShort(String(m.createdAt).slice(0, 10)) : ""}
                      </span>
                      <Link to="/messages" className="ms-auto text-xs font-semibold text-blue-700 underline">
                        قائمة الإرسال
                      </Link>
                    </div>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-slate-600">
                      {m.body}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {preview.isError ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {errorText(preview.error)}
        </p>
      ) : null}

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title="معاينة التقرير">
        <div className="space-y-4">
          <p className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-7 text-slate-800">
            {previewBody || "لا يوجد نص للمعاينة."}
          </p>
          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4">
            <Button variant="ghost" onClick={() => setPreviewOpen(false)}>
              إغلاق
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
              {copied ? "تم النسخ ✓" : "نسخ النص"}
            </Button>
            <Button
              disabled={!data || !previewBody}
              onClick={() => {
                if (!data || !previewBody) return;
                window.open(waLink(data.parentPhone, previewBody), "_blank");
              }}
            >
              فتح واتساب
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default StudentDetail;
