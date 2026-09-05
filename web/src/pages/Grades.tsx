import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Assessment, ClassGroup } from "../api/types";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
} from "../components/ui";
import { arDateShort, arNum, todayISO } from "../lib/format";

type AssessmentRow = Assessment & {
  classGroup?: { id?: string; name?: string; subject?: string; color?: string } | null;
  gradedCount?: number;
  averagePercentage?: number | string | null;
};

type AssessmentForm = {
  classGroupId: string;
  title: string;
  type: string;
  maxScore: string;
  date: string;
};

const TYPES: { value: string; label: string }[] = [
  { value: "QUIZ", label: "اختبار قصير" },
  { value: "EXAM", label: "امتحان" },
  { value: "HOMEWORK", label: "واجب" },
];

const TYPE_AR: Record<string, string> = {
  QUIZ: "اختبار قصير",
  EXAM: "امتحان",
  HOMEWORK: "واجب",
};

function emptyForm(classGroupId: string): AssessmentForm {
  return {
    classGroupId,
    title: "",
    type: "QUIZ",
    maxScore: "20",
    date: todayISO(),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "حدث خطأ غير متوقع";
}

function pctText(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${arNum(Math.round(n * 10) / 10)}٪`;
}

function pctTone(value: number | string | null | undefined): "green" | "amber" | "red" | "gray" {
  if (value === null || value === undefined || value === "") return "gray";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "gray";
  if (n < 60) return "red";
  if (n < 75) return "amber";
  return "green";
}

export function Grades() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [classId, setClassId] = useState("");
  const [form, setForm] = useState<AssessmentForm | null>(null);
  const [formError, setFormError] = useState("");

  const classes = useQuery({
    queryKey: ["classes"],
    queryFn: () => api.get<ClassGroup[]>("/classes"),
  });

  const assessments = useQuery({
    queryKey: ["assessments", classId],
    queryFn: () =>
      api.get<AssessmentRow[]>(
        `/assessments${classId ? `?classId=${encodeURIComponent(classId)}` : ""}`,
      ),
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<AssessmentRow>("/assessments", body),
    onSuccess: (created) => {
      setForm(null);
      setFormError("");
      queryClient.invalidateQueries({ queryKey: ["assessments"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      if (created?.id) navigate(`/grades/${created.id}`);
    },
    onError: (error) => setFormError(errorText(error)),
  });

  const rows = assessments.data ?? [];
  const classList = classes.data ?? [];

  const submit = () => {
    if (!form) return;
    const maxScore = Number(form.maxScore);
    if (!form.classGroupId) {
      setFormError("اختر المجموعة أولاً.");
      return;
    }
    if (!form.title.trim()) {
      setFormError("عنوان الاختبار مطلوب.");
      return;
    }
    if (!Number.isFinite(maxScore) || maxScore <= 0) {
      setFormError("الدرجة الكاملة يجب أن تكون رقماً أكبر من صفر.");
      return;
    }
    if (!form.date) {
      setFormError("تاريخ الاختبار مطلوب.");
      return;
    }
    setFormError("");
    create.mutate({
      classGroupId: form.classGroupId,
      title: form.title.trim(),
      type: form.type,
      maxScore,
      date: form.date,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="الدرجات" subtitle="الاختبارات والواجبات ونتائج الطلاب" />
        <Button
          disabled={classList.length === 0}
          onClick={() => {
            setFormError("");
            setForm(emptyForm(classId || classList[0]?.id || ""));
          }}
        >
          اختبار جديد
        </Button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:max-w-sm">
        <Select label="تصفية حسب المجموعة" value={classId} onChange={(e) => setClassId(e.target.value)}>
          <option value="">كل المجموعات</option>
          {classList.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>

      {assessments.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : assessments.isError ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {errorText(assessments.error)}
        </p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <EmptyState
            title="لا توجد اختبارات"
            hint={
              classList.length === 0
                ? "أنشئ مجموعة أولاً ثم أضف اختباراً لها."
                : "أضف اختباراً جديداً لتسجيل درجات الطلاب وإرسال تنبيهات المستوى."
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((a) => (
            <article
              key={a.id}
              className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-bold text-slate-900">{a.title}</h2>
                  <p className="truncate text-sm text-slate-500">
                    {a.classGroup?.name ?? ""}
                    {a.classGroup?.subject ? ` · ${a.classGroup.subject}` : ""}
                  </p>
                </div>
                <Badge tone="blue">{TYPE_AR[a.type] ?? a.type}</Badge>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
                <span>{a.date ? arDateShort(a.date) : ""}</span>
                <span className="tabular-nums">الدرجة الكاملة {arNum(a.maxScore ?? 0)}</span>
                <span className="tabular-nums">
                  المصححة {arNum(a.gradedCount ?? 0)}
                </span>
              </div>

              <div className="mt-auto flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                <span className="flex items-center gap-2 text-sm text-slate-600">
                  المتوسط
                  <Badge tone={pctTone(a.averagePercentage)}>{pctText(a.averagePercentage)}</Badge>
                </span>
                <Button size="sm" variant="secondary" onClick={() => navigate(`/grades/${a.id}`)}>
                  إدخال الدرجات
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal open={form !== null} onClose={() => setForm(null)} title="اختبار جديد">
        {form ? (
          <div className="space-y-4">
            <Select
              label="المجموعة"
              value={form.classGroupId}
              onChange={(e) => setForm({ ...form, classGroupId: e.target.value })}
            >
              <option value="">— اختر المجموعة —</option>
              {classList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>

            <Input
              label="العنوان"
              placeholder="اختبار الوحدة الأولى"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <Select
                label="النوع"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
              >
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
              <Input
                label="الدرجة الكاملة"
                type="number"
                min={1}
                value={form.maxScore}
                onChange={(e) => setForm({ ...form, maxScore: e.target.value })}
              />
              <Input
                label="التاريخ"
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </div>

            {formError ? (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
                {formError}
              </p>
            ) : null}

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
              <Button variant="ghost" onClick={() => setForm(null)}>
                إلغاء
              </Button>
              <Button onClick={submit} disabled={create.isPending}>
                {create.isPending ? "جارٍ الإنشاء…" : "إنشاء ثم إدخال الدرجات"}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default Grades;
