import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import type { DashboardData, QueueReportsResult } from "../api/types";
import {
  Button,
  Card,
  EmptyState,
  Input,
  LoadingBlock,
  PageHeader,
} from "../components/ui";
import { arDate, arNum, arPercent, arTime, currentMonthISO, todayISO } from "../lib/format";

function ErrorLine({ error }: { error: unknown }) {
  return (
    <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
      {errorMessage(error)}
    </p>
  );
}

function StatTile(props: {
  label: string;
  value: string;
  hint?: string;
  tone?: "blue" | "emerald" | "amber" | "slate";
  to?: string;
}) {
  const tone = props.tone ?? "slate";
  const surface: Record<string, string> = {
    blue: "border-blue-200 bg-blue-50",
    emerald: "border-emerald-200 bg-emerald-50",
    amber: "border-amber-200 bg-amber-50",
    slate: "border-slate-200 bg-white",
  };
  const value: Record<string, string> = {
    blue: "text-blue-700",
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    slate: "text-slate-900",
  };
  const body = (
    <>
      <p className="text-sm font-medium text-slate-600">{props.label}</p>
      <p className={`mt-1 text-3xl font-extrabold tabular-nums ${value[tone]}`}>{props.value}</p>
      {props.hint ? <p className="mt-1 text-xs text-slate-500">{props.hint}</p> : null}
    </>
  );
  const className = `block rounded-xl border p-4 text-start shadow-sm transition ${surface[tone]}`;
  return props.to ? (
    <Link to={props.to} className={`${className} hover:shadow-md`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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

  return (
    <div>
      <PageHeader
        title="لوحة التحكم"
        subtitle={arDate(todayISO())}
        actions={<Button onClick={() => navigate("/attendance")}>تسجيل حضور اليوم</Button>}
      />

      {dashboard.isLoading ? (
        <LoadingBlock />
      ) : dashboard.isError ? (
        <ErrorLine error={dashboard.error} />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile label="الطلاب" value={arNum(data?.totals?.students ?? 0)} to="/students" />
            <StatTile label="المجموعات" value={arNum(data?.totals?.classes ?? 0)} to="/classes" />
            <StatTile label="الاختبارات" value={arNum(data?.totals?.assessments ?? 0)} to="/grades" />
            <StatTile
              label="رسائل قيد الانتظار"
              value={arNum(pending)}
              hint="بانتظار الإرسال إلى أولياء الأمور"
              tone={pending > 0 ? "amber" : "slate"}
              to="/messages"
            />
            <StatTile
              label="حضور هذا الأسبوع"
              value={arPercent(data?.weekAttendanceRate ?? 0)}
              tone="emerald"
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2" title="حصص اليوم" bodyClassName="p-0">
              {todaySessions.length === 0 ? (
                <EmptyState
                  title="لا توجد حصص اليوم"
                  hint="تُنشأ الحصص تلقائياً من الجدول الأسبوعي لكل مجموعة."
                  action={
                    <Button variant="secondary" onClick={() => navigate("/classes")}>
                      إدارة المجموعات والمواعيد
                    </Button>
                  }
                />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {todaySessions.map((session) => {
                    const total = session.counts?.total ?? 0;
                    const unmarked = session.counts?.unmarked ?? 0;
                    return (
                      <li key={session.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                        <span
                          className="h-10 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: session.classGroup?.color ?? "#2563eb" }}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold text-slate-900">
                            {session.classGroup?.name ?? "مجموعة"}
                          </p>
                          <p className="truncate text-sm text-slate-500">
                            {session.classGroup?.subject ?? ""} · {arTime(session.startTime)}
                          </p>
                        </div>
                        {total > 0 ? (
                          <span className="text-sm font-medium tabular-nums">
                            {unmarked > 0 ? (
                              <span className="text-amber-700">
                                {arNum(unmarked)} بدون تسجيل
                              </span>
                            ) : (
                              <span className="text-emerald-700">اكتمل التسجيل</span>
                            )}
                          </span>
                        ) : null}
                        <Link
                          to="/attendance"
                          className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
                        >
                          تسجيل الحضور
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <div className="space-y-6">
              <Card title="طلاب تحت المستوى">
                {lowPerformers.length === 0 ? (
                  <p className="text-sm text-slate-500">لا يوجد طلاب تحت المستوى المطلوب.</p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {lowPerformers.map((student) => (
                      <li
                        key={student.studentId}
                        className="flex items-center justify-between gap-3 py-2.5"
                      >
                        <Link
                          to={`/students/${student.studentId}`}
                          className="min-w-0 flex-1 truncate font-medium text-slate-800 hover:text-blue-700"
                        >
                          {student.name}
                        </Link>
                        <span className="rounded-lg bg-rose-50 px-2 py-1 text-sm font-bold tabular-nums text-rose-700">
                          {arPercent(student.averagePercentage ?? 0)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card title="كثيرو الغياب هذا الشهر">
                {chronicAbsentees.length === 0 ? (
                  <p className="text-sm text-slate-500">لا توجد حالات غياب متكررة.</p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {chronicAbsentees.map((student) => (
                      <li
                        key={student.studentId}
                        className="flex items-center justify-between gap-3 py-2.5"
                      >
                        <Link
                          to={`/students/${student.studentId}`}
                          className="min-w-0 flex-1 truncate font-medium text-slate-800 hover:text-blue-700"
                        >
                          {student.name}
                        </Link>
                        <span className="rounded-lg bg-amber-50 px-2 py-1 text-sm font-bold tabular-nums text-amber-700">
                          {arNum(student.absentCount ?? 0)} غياب
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>

          <Card title="التقارير الشهرية">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-48">
                <Input
                  label="الشهر"
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                />
              </div>
              <Button
                variant="secondary"
                disabled={!month || queueReports.isPending}
                onClick={() => {
                  setReportNotice("");
                  queueReports.mutate(month);
                }}
              >
                {queueReports.isPending ? "جارٍ التجهيز…" : "إضافة تقارير الشهر إلى قائمة الإرسال"}
              </Button>
              {reportNotice ? (
                <p className="pb-2 text-sm font-medium text-emerald-700">
                  {reportNotice} ·{" "}
                  <Link to="/messages" className="underline underline-offset-4">
                    فتح قائمة الإرسال
                  </Link>
                </p>
              ) : null}
            </div>
            {queueReports.isError ? (
              <div className="mt-3">
                <ErrorLine error={queueReports.error} />
              </div>
            ) : null}
            <p className="mt-3 text-xs text-slate-500">
              يُجهَّز تقرير لكل طالب نشط يتضمن حضوره ومتوسط درجاته خلال الشهر المحدد، ثم يُرسَل من
              قائمة الإرسال.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}

export default Dashboard;
