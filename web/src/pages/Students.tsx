/**
 * الطلاب — the roster.
 *
 * Restyled to the Telda-style language: one filter row above a stack of row
 * cards, each card carrying an avatar, the name, the parent's contact details
 * and the classes the student belongs to. Every colour comes from a token in
 * index.css; the only literal colours are the ones stored on a class row, which
 * are data rather than styling.
 *
 * Behaviour is untouched — same query keys, same mutations, same Arabic.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";

import { api, buildQuery, errorMessage } from "../api/client";
import type { ClassGroup, Student, StudentInput } from "../api/types";
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  EmptyState,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Select,
  Textarea,
  cn,
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

/* ────────────────────────────── small pieces ──────────────────────────── */

/** A failure the teacher has to read: tinted, never a bare red sentence. */
function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-2xl border border-[var(--border)] bg-[var(--absent-soft)] px-4 py-3 text-start text-sm font-semibold text-[var(--absent-ink)]">
      {children}
    </p>
  );
}

/** The first letter of the name in a --brand-soft disc. */
function Avatar({ name, className }: { name: string; className?: string }) {
  const letter = name.trim().charAt(0) || "؟";
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--brand-soft)] text-base font-bold text-[var(--brand-ink)]",
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

/**
 * A class chip. The class's own colour is data, so it is used as a soft tint
 * plus a dot rather than a solid fill — an arbitrarily light or dark stored
 * colour can never swallow the label. The name is always printed, so the
 * colour never carries the meaning alone.
 */
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

/** A checkbox that reads as a chip: --surface-2 idle, --brand-soft when on. */
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

  const openNew = () => {
    setFormError("");
    setForm({ ...EMPTY_FORM });
  };

  return (
    <div>
      <PageHeader
        title="الطلاب"
        subtitle={`${arNum(rows.length)} طالب في القائمة الحالية`}
        actions={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" aria-hidden />
            طالب جديد
          </Button>
        }
      />

      <div className="space-y-6">
        {/* ── filters: one row above the list ─────────────────────────── */}
        <Card>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_16rem_auto]">
            <Input
              label="بحث"
              placeholder="اسم الطالب أو ولي الأمر أو الهاتف"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select label="المجموعة" value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">كل المجموعات</option>
              {(classes.data ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
            <CheckToggle checked={showInactive} onChange={setShowInactive}>
              إظهار غير النشطين
            </CheckToggle>
          </div>
        </Card>

        {remove.isError ? <ErrorNote>{errorMessage(remove.error)}</ErrorNote> : null}

        {students.isLoading ? (
          <Card bodyClassName="p-0">
            <LoadingBlock label="جارٍ تحميل الطلاب…" />
          </Card>
        ) : students.isError ? (
          <ErrorNote>{errorMessage(students.error)}</ErrorNote>
        ) : rows.length === 0 ? (
          <Card bodyClassName="p-0">
            <EmptyState
              icon={<Users className="h-6 w-6" aria-hidden />}
              title="لا يوجد طلاب"
              hint="أضف أول طالب لتبدأ تسجيل الحضور وإرسال التنبيهات لأولياء الأمور."
              action={
                <Button onClick={openNew}>
                  <Plus className="h-4 w-4" aria-hidden />
                  طالب جديد
                </Button>
              }
            />
          </Card>
        ) : (
          <ul className="space-y-3">
            {rows.map((student) => {
              const chips = student.classes ?? [];
              const shared = sharedPhones.has((student.parentPhone ?? "").trim());
              return (
                <li key={student.id}>
                  <article className="elev flex flex-col gap-4 rounded-[20px] border border-[var(--border)] bg-[var(--surface)] p-5 transition-colors duration-150 hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] md:flex-row md:items-center md:gap-5 md:p-6">
                    <div className="flex min-w-0 flex-1 items-start gap-3.5">
                      <Avatar name={student.name} />

                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            to={`/students/${student.id}`}
                            className="truncate text-base font-semibold text-[var(--ink)] transition-colors duration-150 hover:text-[var(--brand-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                          >
                            {student.name}
                          </Link>
                          {student.isActive === false ? <Badge tone="gray">غير نشط</Badge> : null}
                          {shared ? <Badge tone="amber">رقم مشترك</Badge> : null}
                        </div>

                        <p className="truncate text-xs text-[var(--ink-3)]">{student.gradeLevel}</p>

                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--ink-2)]">
                          <span className="truncate">{student.parentName}</span>
                          <span aria-hidden className="text-[var(--ink-3)]">
                            ·
                          </span>
                          <span dir="ltr" className="tabular-nums">
                            {student.parentPhone}
                          </span>
                          {student.altPhone ? (
                            <>
                              <span aria-hidden className="text-[var(--ink-3)]">
                                ·
                              </span>
                              <span dir="ltr" className="tabular-nums text-[var(--ink-3)]">
                                {student.altPhone}
                              </span>
                            </>
                          ) : null}
                        </div>

                        {chips.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {chips.map((chip) => (
                              <ClassChip key={chip.id} name={chip.name} color={chip.color} />
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-[var(--ink-3)]">غير مسجّل في أي مجموعة</p>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-4 md:shrink-0 md:flex-nowrap md:border-0 md:pt-0">
                      <Link
                        to={`/students/${student.id}`}
                        className="inline-flex h-9 select-none items-center rounded-2xl px-3.5 text-sm font-semibold text-[var(--brand-ink)] transition-colors duration-150 hover:bg-[var(--brand-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
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
                      <span className="ms-auto md:ms-0">
                        <ConfirmButton size="sm" onConfirm={() => remove.mutate(student.id)}>
                          حذف
                        </ConfirmButton>
                      </span>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── add / edit ──────────────────────────────────────────────────── */}
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

            <p className="text-start text-xs text-[var(--ink-3)]">
              يُحفَظ رقم الهاتف بالصيغة الدولية تلقائياً، فيمكن كتابته بأي شكل مألوف.
            </p>

            {formError ? <ErrorNote>{formError}</ErrorNote> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default Students;
