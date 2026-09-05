import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, buildQuery, errorMessage } from "../api/client";
import type { ClassGroup, Student, StudentInput } from "../api/types";
import {
  Badge,
  Button,
  ConfirmButton,
  EmptyState,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Select,
  Textarea,
} from "../components/ui";
import { arNum } from "../lib/format";

type StudentForm = {
  id: string | null;
  name: string;
  parentName: string;
  parentPhone: string;
  altPhone: string;
  gradeLevel: string;
  notes: string;
  isActive: boolean;
};

const EMPTY_FORM: StudentForm = {
  id: null,
  name: "",
  parentName: "",
  parentPhone: "",
  altPhone: "",
  gradeLevel: "",
  notes: "",
  isActive: true,
};

const GRADE_SUGGESTIONS = [
  "الصف الأول الإعدادي",
  "الصف الثاني الإعدادي",
  "الصف الثالث الإعدادي",
  "الصف الأول الثانوي",
  "الصف الثاني الثانوي",
  "الصف الثالث الثانوي",
];

/**
 * Sends a trimmed value, `null` when the teacher cleared a value that used to
 * exist, and `undefined` (key omitted) when the field was empty all along.
 */
function optionalField(next: string, previous?: string | null): string | null | undefined {
  const value = next.trim();
  if (value) return value;
  return previous ? null : undefined;
}

function toInput(form: StudentForm, previous?: Student): StudentInput {
  const body: StudentInput = {
    name: form.name.trim(),
    parentName: form.parentName.trim(),
    parentPhone: form.parentPhone.trim(),
    gradeLevel: form.gradeLevel.trim(),
    isActive: form.isActive,
  };
  const altPhone = optionalField(form.altPhone, previous?.altPhone);
  if (altPhone !== undefined) body.altPhone = altPhone;
  const notes = optionalField(form.notes, previous?.notes);
  if (notes !== undefined) body.notes = notes;
  return body;
}

export function Students() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [classId, setClassId] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState<StudentForm | null>(null);
  const [formError, setFormError] = useState("");

  const classes = useQuery({
    queryKey: ["classes"],
    queryFn: () => api.get<ClassGroup[]>("/classes"),
  });

  const students = useQuery({
    queryKey: ["students", { q: search, classId, showInactive }],
    queryFn: () =>
      api.get<Student[]>(
        `/students${buildQuery({
          q: search.trim(),
          classId,
          active: showInactive ? "" : "true",
        })}`,
      ),
  });

  const rows = students.data ?? [];

  /** Two siblings sharing one parent number is legitimate — flag it, don't block it. */
  const sharedPhones = useMemo(() => {
    const counts = new Map<string, number>();
    for (const student of rows) {
      const phone = (student.parentPhone ?? "").trim();
      if (!phone) continue;
      counts.set(phone, (counts.get(phone) ?? 0) + 1);
    }
    const shared = new Set<string>();
    counts.forEach((count, phone) => {
      if (count > 1) shared.add(phone);
    });
    return shared;
  }, [rows]);

  const editing = form?.id ? rows.find((student) => student.id === form.id) : undefined;

  const save = useMutation({
    mutationFn: (payload: { id: string | null; body: StudentInput }) =>
      payload.id
        ? api.patch<Student>(`/students/${payload.id}`, payload.body)
        : api.post<Student>("/students", payload.body),
    onSuccess: () => {
      setForm(null);
      setFormError("");
      queryClient.invalidateQueries({ queryKey: ["students"] });
      queryClient.invalidateQueries({ queryKey: ["classes"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del<{ ok?: boolean }>(`/students/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["students"] });
      queryClient.invalidateQueries({ queryKey: ["classes"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const submit = () => {
    if (!form) return;
    if (!form.name.trim() || !form.parentName.trim() || !form.parentPhone.trim()) {
      setFormError("اسم الطالب واسم ولي الأمر ورقم الهاتف حقول مطلوبة.");
      return;
    }
    if (!form.gradeLevel.trim()) {
      setFormError("المرحلة الدراسية مطلوبة.");
      return;
    }
    setFormError("");
    save.mutate({ id: form.id, body: toInput(form, editing) });
  };

  return (
    <div>
      <PageHeader
        title="الطلاب"
        subtitle={`${arNum(rows.length)} طالب في القائمة الحالية`}
        actions={
          <Button
            onClick={() => {
              setFormError("");
              setForm({ ...EMPTY_FORM });
            }}
          >
            طالب جديد
          </Button>
        }
      />

      <div className="space-y-6">
        <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-3">
          <Input
            label="بحث"
            placeholder="اسم الطالب أو ولي الأمر أو الهاتف"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            label="المجموعة"
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
          >
            <option value="">كل المجموعات</option>
            {(classes.data ?? []).map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
          <label className="flex cursor-pointer items-center gap-2 self-end rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors has-[:checked]:border-blue-300 has-[:checked]:bg-blue-50">
            <input
              type="checkbox"
              className="h-4 w-4 accent-blue-600"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            إظهار الطلاب غير النشطين
          </label>
        </div>

        {remove.isError ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
            {errorMessage(remove.error)}
          </p>
        ) : null}

        {students.isLoading ? (
          <LoadingBlock />
        ) : students.isError ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
            {errorMessage(students.error)}
          </p>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <EmptyState
              title="لا يوجد طلاب"
              hint="أضف أول طالب لتبدأ تسجيل الحضور وإرسال التنبيهات لأولياء الأمور."
              action={
                <Button
                  onClick={() => {
                    setFormError("");
                    setForm({ ...EMPTY_FORM });
                  }}
                >
                  طالب جديد
                </Button>
              }
            />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((student) => {
              const chips = student.classes ?? [];
              const shared = sharedPhones.has((student.parentPhone ?? "").trim());
              return (
                <article
                  key={student.id}
                  className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        to={`/students/${student.id}`}
                        className="block truncate text-base font-bold text-slate-900 hover:text-blue-700"
                      >
                        {student.name}
                      </Link>
                      <p className="truncate text-sm text-slate-500">{student.gradeLevel}</p>
                    </div>
                    {student.isActive === false ? <Badge tone="gray">غير نشط</Badge> : null}
                  </div>

                  <div className="space-y-1 text-sm">
                    <p className="truncate text-slate-700">
                      <span className="text-slate-500">ولي الأمر: </span>
                      {student.parentName}
                    </p>
                    <p className="flex flex-wrap items-center gap-2 text-slate-700">
                      <span className="text-slate-500">الهاتف:</span>
                      <span dir="ltr" className="font-mono">
                        {student.parentPhone}
                      </span>
                      {shared ? <Badge tone="amber">رقم مشترك</Badge> : null}
                    </p>
                    {student.altPhone ? (
                      <p className="flex items-center gap-2 text-slate-700">
                        <span className="text-slate-500">رقم بديل:</span>
                        <span dir="ltr" className="font-mono">
                          {student.altPhone}
                        </span>
                      </p>
                    ) : null}
                  </div>

                  {chips.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {chips.map((chip) => (
                        <span
                          key={chip.id}
                          className="rounded-full px-2.5 py-1 text-xs font-semibold text-white"
                          style={{ backgroundColor: chip.color || "#2563eb" }}
                        >
                          {chip.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400">غير مسجّل في أي مجموعة</p>
                  )}

                  <div className="mt-auto flex items-center gap-2 border-t border-slate-100 pt-3">
                    <Link
                      to={`/students/${student.id}`}
                      className="rounded-xl px-3 py-2 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-50"
                    >
                      التفاصيل
                    </Link>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setFormError("");
                        setForm({
                          id: student.id,
                          name: student.name ?? "",
                          parentName: student.parentName ?? "",
                          parentPhone: student.parentPhone ?? "",
                          altPhone: student.altPhone ?? "",
                          gradeLevel: student.gradeLevel ?? "",
                          notes: student.notes ?? "",
                          isActive: student.isActive !== false,
                        });
                      }}
                    >
                      تعديل
                    </Button>
                    <span className="ms-auto">
                      <ConfirmButton size="sm" onConfirm={() => remove.mutate(student.id)}>
                        حذف
                      </ConfirmButton>
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? "تعديل بيانات الطالب" : "طالب جديد"}
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
                list="grade-levels"
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
                placeholder="01001234567"
                value={form.parentPhone}
                onChange={(e) => setForm({ ...form, parentPhone: e.target.value })}
              />
              <Input
                label="رقم بديل (اختياري)"
                dir="ltr"
                value={form.altPhone}
                onChange={(e) => setForm({ ...form, altPhone: e.target.value })}
              />
              <label className="flex cursor-pointer items-center gap-2 self-end rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors has-[:checked]:border-emerald-300 has-[:checked]:bg-emerald-50">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-emerald-600"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                طالب نشط
              </label>
            </div>

            <datalist id="grade-levels">
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

            <p className="text-xs text-slate-500">
              يُحفَظ رقم الهاتف بالصيغة الدولية تلقائياً، فيمكن كتابته بأي شكل مألوف.
            </p>

            {formError ? (
              <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
                {formError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default Students;
