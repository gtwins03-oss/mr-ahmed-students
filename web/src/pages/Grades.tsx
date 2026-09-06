/**
 * /grades — the list of assessments.
 *
 * Each assessment is a card rather than a table row: on a phone a row of six
 * numeric columns is unreadable, and the one number that actually matters —
 * the class average — deserves to be printed at full size with a meter under
 * it rather than squeezed into a cell.
 *
 * The meter is --brand in the ordinary case and --absent only when the class
 * is under the low-grade line. There is exactly one accent in this design, so
 * a green/amber/red traffic light per card is deliberately not used.
 */

import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import type { Assessment, ClassGroup } from "../api/types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  LoadingBlock,
  Meter,
  Modal,
  PageHeader,
  Select,
  type Tone,
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

/**
 * The server's default low-grade line, mirrored here purely to decide whether
 * a card's meter is drawn in --absent. The authoritative value lives in
 * `Settings.lowGradeThreshold` and is read on the entry screen; fetching it
 * here just to tint a bar would cost a request this page does not otherwise
 * need.
 */
const LOW_GRADE_LINE = 60;

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

/** The average as a finite number, or null when the server has nothing yet. */
function pctValue(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function pctText(value: number | string | null | undefined): string {
  const n = pctValue(value);
  if (n === null) return "—";
  return `${arNum(Math.round(n * 10) / 10)}٪`;
}

function pctTone(value: number | string | null | undefined): Tone {
  const n = pctValue(value);
  if (n === null) return "gray";
  return n < LOW_GRADE_LINE ? "red" : "brand";
}

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

  /**
   * How many students the assessment's class holds. `/assessments` does not
   * carry a roster size, but `/classes` — already fetched for the filter — does,
   * so «تم تصحيح ١٨ من ٢٤» costs nothing extra. Undefined while /classes is
   * still in flight, in which case the denominator is simply not printed.
   */
  const rosterSizeOf = (row: AssessmentRow): number | undefined =>
    classList.find((c) => c.id === row.classGroupId)?.studentCount;

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
    <div>
      <PageHeader
        title="الدرجات"
        subtitle="الاختبارات والواجبات ونتائج الطلاب"
        actions={
          <Button
            disabled={classList.length === 0}
            onClick={() => {
              setFormError("");
              setForm(emptyForm(classId || classList[0]?.id || ""));
            }}
          >
            اختبار جديد
          </Button>
        }
      />

      <div className="space-y-6">
        <Card className="sm:max-w-sm">
          <Select
            label="تصفية حسب المجموعة"
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
          >
            <option value="">كل المجموعات</option>
            {classList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Card>

        {assessments.isLoading ? (
          <Card bodyClassName="p-0">
            <LoadingBlock />
          </Card>
        ) : assessments.isError ? (
          <ErrorNote>{errorText(assessments.error)}</ErrorNote>
        ) : rows.length === 0 ? (
          <Card bodyClassName="p-0">
            <EmptyState
              title="لا توجد اختبارات"
              hint={
                classList.length === 0
                  ? "أنشئ مجموعة أولاً ثم أضف اختباراً لها."
                  : "أضف اختباراً جديداً لتسجيل درجات الطلاب وإرسال تنبيهات المستوى."
              }
            />
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((a) => {
              const rosterSize = rosterSizeOf(a);
              const graded = a.gradedCount ?? 0;
              const average = pctValue(a.averagePercentage);
              return (
                <article
                  key={a.id}
                  className="elev flex flex-col gap-4 rounded-[20px] border border-[var(--border)] bg-[var(--surface)] p-5 transition-colors duration-150 hover:border-[var(--border-strong)] sm:p-6"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-start text-base font-semibold text-[var(--ink)]">
                        {a.title}
                      </h2>
                      <p className="mt-1.5 flex min-w-0 items-center gap-2 text-start text-xs text-[var(--ink-3)]">
                        <span
                          aria-hidden
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: a.classGroup?.color || "var(--brand)" }}
                        />
                        <span className="truncate">
                          {a.classGroup?.name ?? ""}
                          {a.classGroup?.subject ? ` · ${a.classGroup.subject}` : ""}
                        </span>
                      </p>
                    </div>
                    <Badge tone="brand" className="shrink-0">
                      {TYPE_AR[a.type] ?? a.type}
                    </Badge>
                  </div>

                  <dl className="space-y-1.5 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-[var(--ink-3)]">التاريخ</dt>
                      <dd className="text-[var(--ink-2)]">{a.date ? arDateShort(a.date) : "—"}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-[var(--ink-3)]">الدرجة الكاملة</dt>
                      <dd className="tabular-nums text-[var(--ink-2)]">{arNum(a.maxScore ?? 0)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-[var(--ink-3)]">التصحيح</dt>
                      <dd className="tabular-nums text-[var(--ink-2)]">
                        {rosterSize === undefined
                          ? `تم تصحيح ${arNum(graded)}`
                          : `تم تصحيح ${arNum(graded)} من ${arNum(rosterSize)}`}
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-auto border-t border-[var(--border)] pt-4">
                    <p className="text-end text-xs font-semibold text-[var(--ink-3)]">
                      متوسط المجموعة
                    </p>
                    <p className="mt-1.5 text-end text-4xl font-bold leading-none tracking-tight text-[var(--ink)]">
                      {pctText(a.averagePercentage)}
                    </p>
                    <Meter
                      value={average ?? 0}
                      tone={pctTone(a.averagePercentage)}
                      label={`متوسط ${a.title}`}
                      className="mt-4"
                    />
                  </div>

                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full"
                    onClick={() => navigate(`/grades/${a.id}`)}
                  >
                    إدخال الدرجات
                  </Button>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title="اختبار جديد"
        footer={
          form ? (
            <>
              <Button onClick={submit} disabled={create.isPending}>
                {create.isPending ? "جارٍ الإنشاء…" : "إنشاء ثم إدخال الدرجات"}
              </Button>
              <Button variant="ghost" onClick={() => setForm(null)}>
                إلغاء
              </Button>
            </>
          ) : undefined
        }
      >
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
                dir="ltr"
                className="tabular-nums"
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

            {formError ? <ErrorNote>{formError}</ErrorNote> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default Grades;
