import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ClassGroup, ScheduleSlot, Student } from "../api/types";
import {
  Badge,
  Button,
  ConfirmButton,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
} from "../components/ui";
import { WEEKDAYS_AR, arNum, arTime } from "../lib/format";

type ClassRow = ClassGroup & { slots?: ScheduleSlot[]; studentCount?: number };

type SlotDraft = { weekday: number; startTime: string; endTime: string; location: string };

type ClassForm = {
  id: string | null;
  name: string;
  subject: string;
  gradeLevel: string;
  color: string;
  slots: SlotDraft[];
};

const COLORS = [
  "#2563eb",
  "#0891b2",
  "#059669",
  "#65a30d",
  "#d97706",
  "#dc2626",
  "#db2777",
  "#7c3aed",
  "#475569",
];

const EMPTY_FORM: ClassForm = {
  id: null,
  name: "",
  subject: "",
  gradeLevel: "",
  color: COLORS[0],
  slots: [{ weekday: 6, startTime: "16:00", endTime: "17:30", location: "" }],
};

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "حدث خطأ غير متوقع";
}

function weekdayLabel(weekday: number): string {
  return WEEKDAYS_AR[weekday] ?? "";
}

function slotText(slot: { weekday: number; startTime: string; endTime?: string | null }): string {
  const end = slot.endTime ? ` - ${arTime(slot.endTime)}` : "";
  return `${weekdayLabel(slot.weekday)} ${arTime(slot.startTime)}${end}`;
}

export function Classes() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ClassForm | null>(null);
  const [formError, setFormError] = useState("");
  const [rosterFor, setRosterFor] = useState<ClassRow | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [rosterSearch, setRosterSearch] = useState("");

  const classes = useQuery({
    queryKey: ["classes"],
    queryFn: () => api.get<ClassRow[]>("/classes"),
  });

  const allStudents = useQuery({
    queryKey: ["students", "all"],
    queryFn: () => api.get<Student[]>("/students"),
    enabled: rosterFor !== null,
  });

  const enrolled = useQuery({
    queryKey: ["students", "in-class", rosterFor?.id ?? ""],
    queryFn: () => api.get<Student[]>(`/students?classId=${encodeURIComponent(rosterFor?.id ?? "")}`),
    enabled: rosterFor !== null,
  });

  useEffect(() => {
    if (rosterFor && enrolled.data) {
      setSelected(enrolled.data.map((s) => s.id));
    }
  }, [rosterFor, enrolled.data]);

  const save = useMutation({
    mutationFn: (payload: { id: string | null; body: Record<string, unknown> }) =>
      payload.id
        ? api.patch<ClassGroup>(`/classes/${payload.id}`, payload.body)
        : api.post<ClassGroup>("/classes", payload.body),
    onSuccess: () => {
      setForm(null);
      setFormError("");
      queryClient.invalidateQueries({ queryKey: ["classes"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (error) => setFormError(errorText(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del<{ ok?: boolean }>(`/classes/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["classes"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const saveRoster = useMutation({
    mutationFn: (payload: { id: string; studentIds: string[] }) =>
      api.post<{ ok?: boolean }>(`/classes/${payload.id}/students`, {
        studentIds: payload.studentIds,
      }),
    onSuccess: () => {
      setRosterFor(null);
      queryClient.invalidateQueries({ queryKey: ["classes"] });
      queryClient.invalidateQueries({ queryKey: ["students"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  const rows = classes.data ?? [];

  const rosterList = useMemo(() => {
    const term = rosterSearch.trim();
    const list = (allStudents.data ?? []).filter((s) => s.isActive !== false);
    if (!term) return list;
    return list.filter(
      (s) =>
        s.name.includes(term) ||
        (s.parentName ?? "").includes(term) ||
        (s.parentPhone ?? "").includes(term),
    );
  }, [allStudents.data, rosterSearch]);

  const submit = () => {
    if (!form) return;
    if (!form.name.trim() || !form.subject.trim() || !form.gradeLevel.trim()) {
      setFormError("اسم المجموعة والمادة والمرحلة الدراسية حقول مطلوبة.");
      return;
    }
    if (form.slots.some((s) => !s.startTime || !s.endTime)) {
      setFormError("يجب تحديد وقت البداية والنهاية لكل موعد.");
      return;
    }
    setFormError("");
    save.mutate({
      id: form.id,
      body: {
        name: form.name.trim(),
        subject: form.subject.trim(),
        gradeLevel: form.gradeLevel.trim(),
        color: form.color,
        slots: form.slots.map((s) => ({
          weekday: s.weekday,
          startTime: s.startTime,
          endTime: s.endTime,
          ...(s.location.trim() ? { location: s.location.trim() } : {}),
        })),
      },
    });
  };

  const openEdit = (row: ClassRow) => {
    setFormError("");
    setForm({
      id: row.id,
      name: row.name ?? "",
      subject: row.subject ?? "",
      gradeLevel: row.gradeLevel ?? "",
      color: row.color || COLORS[0],
      slots: (row.slots ?? []).map((s) => ({
        weekday: s.weekday,
        startTime: s.startTime,
        endTime: s.endTime ?? "",
        location: s.location ?? "",
      })),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="المجموعات" subtitle="المواعيد الأسبوعية تُنشئ حصص كل يوم تلقائياً" />
        <Button onClick={() => { setFormError(""); setForm({ ...EMPTY_FORM, slots: [...EMPTY_FORM.slots] }); }}>
          مجموعة جديدة
        </Button>
      </div>

      {remove.isError ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {errorText(remove.error)}
        </p>
      ) : null}

      {classes.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : classes.isError ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {errorText(classes.error)}
        </p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <EmptyState
            title="لا توجد مجموعات"
            hint="أنشئ مجموعة وحدّد مواعيدها الأسبوعية لتظهر حصصها في صفحة الحضور."
          />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => {
            const slots = row.slots ?? [];
            return (
              <article
                key={row.id}
                className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
              >
                <div className="h-1.5 w-full" style={{ backgroundColor: row.color || "#2563eb" }} />
                <div className="flex flex-1 flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-bold text-slate-900">{row.name}</h2>
                      <p className="truncate text-sm text-slate-500">
                        {row.subject} · {row.gradeLevel}
                      </p>
                    </div>
                    <Badge tone="blue">{arNum(row.studentCount ?? 0)} طالب</Badge>
                  </div>

                  <div className="space-y-1">
                    {slots.length === 0 ? (
                      <p className="text-sm text-amber-700">لا توجد مواعيد أسبوعية بعد</p>
                    ) : (
                      slots.map((s) => (
                        <p
                          key={s.id ?? `${s.weekday}-${s.startTime}`}
                          className="flex items-center gap-2 text-sm text-slate-700"
                        >
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-300" />
                          <span className="tabular-nums">{slotText(s)}</span>
                          {s.location ? (
                            <span className="text-xs text-slate-400">({s.location})</span>
                          ) : null}
                        </p>
                      ))
                    )}
                  </div>

                  <div className="mt-auto flex items-center gap-2 border-t border-slate-100 pt-3">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSelected([]);
                        setRosterSearch("");
                        setRosterFor(row);
                      }}
                    >
                      الطلاب
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                      تعديل
                    </Button>
                    <span className="ms-auto">
                      <ConfirmButton onConfirm={() => remove.mutate(row.id)}>حذف</ConfirmButton>
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* ─────────────── add / edit class ─────────────── */}
      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? "تعديل المجموعة" : "مجموعة جديدة"}
      >
        {form ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="اسم المجموعة"
                placeholder="مجموعة السبت - ٣ ثانوي"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <Input
                label="المادة"
                placeholder="الرياضيات"
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
              />
              <Input
                label="المرحلة الدراسية"
                placeholder="الصف الثالث الثانوي"
                value={form.gradeLevel}
                onChange={(e) => setForm({ ...form, gradeLevel: e.target.value })}
              />
              <div>
                <p className="mb-1.5 text-sm font-medium text-slate-700">اللون</p>
                <div className="flex flex-wrap items-center gap-2">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setForm({ ...form, color: c })}
                      style={{ backgroundColor: c }}
                      className={`h-8 w-8 rounded-full transition ${
                        form.color === c ? "ring-2 ring-slate-900 ring-offset-2" : ""
                      }`}
                      aria-label={c}
                    />
                  ))}
                  <input
                    type="color"
                    value={form.color}
                    onChange={(e) => setForm({ ...form, color: e.target.value })}
                    className="h-8 w-10 cursor-pointer rounded border border-slate-300 bg-white"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-800">المواعيد الأسبوعية</h3>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setForm({
                      ...form,
                      slots: [
                        ...form.slots,
                        { weekday: 6, startTime: "16:00", endTime: "17:30", location: "" },
                      ],
                    })
                  }
                >
                  إضافة موعد
                </Button>
              </div>

              {form.slots.length === 0 ? (
                <p className="py-2 text-sm text-slate-500">
                  بدون مواعيد لن تظهر حصص لهذه المجموعة في صفحة الحضور.
                </p>
              ) : (
                <div className="space-y-2">
                  {form.slots.map((slot, index) => (
                    <div key={index} className="flex flex-wrap items-end gap-2">
                      <div className="w-32">
                        <Select
                          label={index === 0 ? "اليوم" : undefined}
                          value={String(slot.weekday)}
                          onChange={(e) => {
                            const slots = [...form.slots];
                            slots[index] = { ...slot, weekday: Number(e.target.value) };
                            setForm({ ...form, slots });
                          }}
                        >
                          {WEEKDAYS_AR.map((day, i) => (
                            <option key={day} value={String(i)}>
                              {day}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="w-32">
                        <Input
                          label={index === 0 ? "من" : undefined}
                          type="time"
                          value={slot.startTime}
                          onChange={(e) => {
                            const slots = [...form.slots];
                            slots[index] = { ...slot, startTime: e.target.value };
                            setForm({ ...form, slots });
                          }}
                        />
                      </div>
                      <div className="w-32">
                        <Input
                          label={index === 0 ? "إلى" : undefined}
                          type="time"
                          value={slot.endTime}
                          onChange={(e) => {
                            const slots = [...form.slots];
                            slots[index] = { ...slot, endTime: e.target.value };
                            setForm({ ...form, slots });
                          }}
                        />
                      </div>
                      <div className="min-w-36 flex-1">
                        <Input
                          label={index === 0 ? "المكان (اختياري)" : undefined}
                          value={slot.location}
                          onChange={(e) => {
                            const slots = [...form.slots];
                            slots[index] = { ...slot, location: e.target.value };
                            setForm({ ...form, slots });
                          }}
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setForm({ ...form, slots: form.slots.filter((_, i) => i !== index) })
                        }
                      >
                        حذف
                      </Button>
                    </div>
                  ))}
                </div>
              )}
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
              <Button onClick={submit} disabled={save.isPending}>
                {save.isPending ? "جارٍ الحفظ…" : "حفظ"}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ─────────────── enrolment ─────────────── */}
      <Modal
        open={rosterFor !== null}
        onClose={() => setRosterFor(null)}
        title={rosterFor ? `طلاب ${rosterFor.name}` : "الطلاب"}
      >
        <div className="space-y-4">
          <Input
            label="بحث"
            placeholder="ابحث بالاسم أو الهاتف"
            value={rosterSearch}
            onChange={(e) => setRosterSearch(e.target.value)}
          />

          <div className="flex items-center gap-2 text-sm">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(rosterList.map((s) => s.id))}
            >
              تحديد الكل
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              إلغاء التحديد
            </Button>
            <span className="ms-auto font-semibold text-slate-600">
              {arNum(selected.length)} محدد
            </span>
          </div>

          {allStudents.isLoading || enrolled.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : allStudents.isError ? (
            <p className="text-sm font-medium text-rose-700">{errorText(allStudents.error)}</p>
          ) : rosterList.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-500">لا يوجد طلاب مطابقون.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200">
              {rosterList.map((s) => {
                const checked = selected.includes(s.id);
                return (
                  <li key={s.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-slate-50 has-[:checked]:bg-blue-50">
                      <input
                        type="checkbox"
                        className="h-5 w-5 accent-blue-600"
                        checked={checked}
                        onChange={(e) =>
                          setSelected((prev) =>
                            e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-slate-800">{s.name}</span>
                        <span className="block truncate text-xs text-slate-500">
                          {s.gradeLevel} · {s.parentName}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {saveRoster.isError ? (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
              {errorText(saveRoster.error)}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
            <Button variant="ghost" onClick={() => setRosterFor(null)}>
              إلغاء
            </Button>
            <Button
              disabled={saveRoster.isPending || !rosterFor}
              onClick={() => {
                if (!rosterFor) return;
                saveRoster.mutate({ id: rosterFor.id, studentIds: selected });
              }}
            >
              {saveRoster.isPending ? "جارٍ الحفظ…" : "حفظ الطلاب"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default Classes;
