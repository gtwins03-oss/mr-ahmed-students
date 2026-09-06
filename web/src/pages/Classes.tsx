/**
 * المجموعات — the class groups and their weekly timetable.
 *
 * Each class is a card carrying its own colour as a 4px accent bar on the
 * inline-start edge (the right edge in RTL), never as a card background: the
 * colour is an identifier, not a mood, and a stored hex must never decide
 * whether the text on top of it is readable.
 *
 * Behaviour is untouched — same query keys, same mutations, same Arabic.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus, Trash2 } from "lucide-react";

import { api } from "../api/client";
import type { ClassGroup, ScheduleSlot, Student } from "../api/types";
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
  cn,
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

/**
 * The colours a class may be painted with. These are *data* — they are stored
 * on the ClassGroup row and travel to every chip in the app — so they have to
 * be literal hexes rather than tokens. They are the one exception to "no raw
 * hex in a page file"; everything else here comes from index.css.
 *
 * Stepped in OKLCH at a constant L 0.60 / C 0.18 and ordered so that no two
 * neighbouring swatches collapse onto each other for a dichromat. Validated
 * with scripts/validate_palette.js against BOTH surfaces — #14161C (dark) and
 * #FFFFFF (light): lightness band, chroma floor, CVD separation (worst adjacent
 * ΔE 9.1 deutan), normal-vision floor (17.6) and 3:1 contrast all PASS. The
 * first entry is the brand accent, so a new group looks like the product.
 *
 * The class name is printed on every chip and every card that carries one of
 * these, so the colour is only ever a second, redundant cue.
 */
const COLORS = [
  "#796ae5",
  "#059a46",
  "#c24ba1",
  "#0683df",
  "#07957c",
  "#d74745",
  "#03919d",
  "#c16302",
];

const NEW_SLOT: SlotDraft = { weekday: 6, startTime: "16:00", endTime: "17:30", location: "" };

const EMPTY_FORM: ClassForm = {
  id: null,
  name: "",
  subject: "",
  gradeLevel: "",
  color: COLORS[0],
  slots: [{ ...NEW_SLOT }],
};

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "حدث خطأ غير متوقع";
}

function weekdayLabel(weekday: number): string {
  return WEEKDAYS_AR[weekday] ?? "";
}

/**
 * A stored class colour reaches CSS as an inline style, so it is checked before
 * it gets there: anything that is not a plain 6-digit hex falls back to the
 * brand accent rather than silently painting `transparent`.
 */
const HEX6 = /^#[0-9a-fA-F]{6}$/;

function accentColor(color?: string): string {
  return HEX6.test(color ?? "") ? (color as string) : "var(--brand)";
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

/** «السبت ٤:٠٠ م – ٥:٣٠ م» — one weekly slot, as a chip. */
function SlotChip({
  slot,
}: {
  slot: { weekday: number; startTime: string; endTime?: string | null; location?: string | null };
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-2)] px-3 py-1 text-xs font-semibold text-[var(--ink-2)]">
      <span className="text-[var(--ink)]">{weekdayLabel(slot.weekday)}</span>
      <span className="tabular-nums">{arTime(slot.startTime)}</span>
      {slot.endTime ? (
        <span className="tabular-nums text-[var(--ink-3)]">– {arTime(slot.endTime)}</span>
      ) : null}
      {slot.location ? <span className="text-[var(--ink-3)]">· {slot.location}</span> : null}
    </span>
  );
}

/** A square icon-only control, sized for a thumb. */
function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-[var(--ink-3)] transition-colors duration-150 hover:bg-[var(--absent-soft)] hover:text-[var(--absent-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
    >
      {children}
    </button>
  );
}

/* ─────────────────────────────── the page ─────────────────────────────── */

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

  const openNew = () => {
    setFormError("");
    setForm({ ...EMPTY_FORM, slots: [{ ...NEW_SLOT }] });
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

  /** Replaces one slot in the draft without touching the others. */
  const patchSlot = (index: number, patch: Partial<SlotDraft>) => {
    if (!form) return;
    const slots = form.slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot));
    setForm({ ...form, slots });
  };

  return (
    <div>
      <PageHeader
        title="المجموعات"
        subtitle="المواعيد الأسبوعية تُنشئ حصص كل يوم تلقائياً"
        actions={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" aria-hidden />
            مجموعة جديدة
          </Button>
        }
      />

      <div className="space-y-6">
        {remove.isError ? <ErrorNote>{errorText(remove.error)}</ErrorNote> : null}

        {classes.isLoading ? (
          <Card bodyClassName="p-0">
            <LoadingBlock label="جارٍ تحميل المجموعات…" />
          </Card>
        ) : classes.isError ? (
          <ErrorNote>{errorText(classes.error)}</ErrorNote>
        ) : rows.length === 0 ? (
          <Card bodyClassName="p-0">
            <EmptyState
              icon={<BookOpen className="h-6 w-6" aria-hidden />}
              title="لا توجد مجموعات"
              hint="أنشئ مجموعة وحدّد مواعيدها الأسبوعية لتظهر حصصها في صفحة الحضور."
              action={
                <Button onClick={openNew}>
                  <Plus className="h-4 w-4" aria-hidden />
                  مجموعة جديدة
                </Button>
              }
            />
          </Card>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((row) => {
              const slots = row.slots ?? [];
              return (
                <li key={row.id} className="flex">
                  <article className="elev relative flex w-full flex-col gap-4 overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--surface)] py-5 pe-5 ps-6 sm:py-6 sm:pe-6 sm:ps-7">
                    {/* The class colour: an edge, never a background. */}
                    <span
                      aria-hidden
                      className="absolute inset-y-0 start-0 w-1"
                      style={{ backgroundColor: accentColor(row.color) }}
                    />

                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="truncate text-start text-base font-semibold text-[var(--ink)]">
                          {row.name}
                        </h2>
                        <p className="mt-1 truncate text-start text-xs text-[var(--ink-3)]">
                          {row.subject} · {row.gradeLevel}
                        </p>
                      </div>
                      <Badge tone="brand" className="shrink-0">
                        {arNum(row.studentCount ?? 0)} طالب
                      </Badge>
                    </div>

                    {slots.length === 0 ? (
                      <p className="text-start text-xs font-semibold text-[var(--late-ink)]">
                        لا توجد مواعيد أسبوعية بعد
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {slots.map((slot) => (
                          <SlotChip key={slot.id ?? `${slot.weekday}-${slot.startTime}`} slot={slot} />
                        ))}
                      </div>
                    )}

                    <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-4">
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
                        <ConfirmButton size="sm" onConfirm={() => remove.mutate(row.id)}>
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

      {/* ─────────────── add / edit class ─────────────── */}
      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? "تعديل المجموعة" : "مجموعة جديدة"}
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
          <div className="space-y-5">
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
                <p className="mb-1.5 text-start text-xs font-semibold text-[var(--ink-3)]">
                  لون المجموعة
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setForm({ ...form, color: c })}
                      style={{ backgroundColor: c }}
                      aria-label={`اللون ${c}`}
                      aria-pressed={form.color === c}
                      className={cn(
                        "h-8 w-8 rounded-full transition-transform duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]",
                        form.color === c
                          ? "ring-2 ring-[var(--ink)] ring-offset-2 ring-offset-[var(--surface)]"
                          : "hover:scale-105",
                      )}
                    />
                  ))}
                  <input
                    type="color"
                    value={form.color}
                    onChange={(e) => setForm({ ...form, color: e.target.value })}
                    aria-label="لون مخصص"
                    className="h-8 w-10 cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-0.5"
                  />
                </div>
              </div>
            </div>

            {/* ── weekly slots ─────────────────────────────────────────── */}
            <div className="space-y-3 rounded-2xl border border-[var(--border)] p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-start text-sm font-semibold text-[var(--ink)]">
                  المواعيد الأسبوعية
                </h3>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setForm({ ...form, slots: [...form.slots, { ...NEW_SLOT }] })}
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  إضافة موعد
                </Button>
              </div>

              {form.slots.length === 0 ? (
                <p className="text-start text-xs text-[var(--ink-3)]">
                  بدون مواعيد لن تظهر حصص لهذه المجموعة في صفحة الحضور.
                </p>
              ) : (
                <ul className="space-y-3">
                  {form.slots.map((slot, index) => (
                    <li
                      key={index}
                      className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-start text-xs font-semibold text-[var(--ink-3)]">
                          الموعد {arNum(index + 1)}
                        </span>
                        <IconButton
                          label="حذف الموعد"
                          onClick={() =>
                            setForm({ ...form, slots: form.slots.filter((_, i) => i !== index) })
                          }
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </IconButton>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="col-span-2 sm:col-span-1">
                          <Select
                            label="اليوم"
                            value={String(slot.weekday)}
                            onChange={(e) => patchSlot(index, { weekday: Number(e.target.value) })}
                          >
                            {WEEKDAYS_AR.map((day, i) => (
                              <option key={day} value={String(i)}>
                                {day}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <Input
                          label="من"
                          type="time"
                          className="tabular-nums"
                          value={slot.startTime}
                          onChange={(e) => patchSlot(index, { startTime: e.target.value })}
                        />
                        <Input
                          label="إلى"
                          type="time"
                          className="tabular-nums"
                          value={slot.endTime}
                          onChange={(e) => patchSlot(index, { endTime: e.target.value })}
                        />
                        <div className="col-span-2">
                          <Input
                            label="المكان (اختياري)"
                            value={slot.location}
                            onChange={(e) => patchSlot(index, { location: e.target.value })}
                          />
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {formError ? <ErrorNote>{formError}</ErrorNote> : null}
          </div>
        ) : null}
      </Modal>

      {/* ─────────────── enrolment ─────────────── */}
      <Modal
        open={rosterFor !== null}
        onClose={() => setRosterFor(null)}
        title={rosterFor ? `طلاب ${rosterFor.name}` : "الطلاب"}
        footer={
          <>
            <Button
              disabled={saveRoster.isPending || !rosterFor}
              onClick={() => {
                if (!rosterFor) return;
                saveRoster.mutate({ id: rosterFor.id, studentIds: selected });
              }}
            >
              {saveRoster.isPending ? "جارٍ الحفظ…" : "حفظ الطلاب"}
            </Button>
            <Button variant="ghost" onClick={() => setRosterFor(null)}>
              إلغاء
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="بحث"
            placeholder="ابحث بالاسم أو الهاتف"
            value={rosterSearch}
            onChange={(e) => setRosterSearch(e.target.value)}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(rosterList.map((s) => s.id))}>
              تحديد الكل
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              إلغاء التحديد
            </Button>
            <span className="ms-auto text-xs font-semibold text-[var(--ink-3)]">
              {arNum(selected.length)} محدد
            </span>
          </div>

          {allStudents.isLoading || enrolled.isLoading ? (
            <LoadingBlock label="جارٍ تحميل الطلاب…" />
          ) : allStudents.isError ? (
            <ErrorNote>{errorText(allStudents.error)}</ErrorNote>
          ) : rosterList.length === 0 ? (
            <EmptyState title="لا يوجد طلاب مطابقون" hint="جرّب اسماً أو رقماً آخر." />
          ) : (
            <ul className="max-h-80 divide-y divide-[var(--border)] overflow-y-auto rounded-2xl border border-[var(--border)]">
              {rosterList.map((s) => {
                const checked = selected.includes(s.id);
                return (
                  <li key={s.id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors duration-150",
                        checked ? "bg-[var(--brand-soft)]" : "hover:bg-[var(--surface-2)]",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="h-5 w-5 shrink-0 accent-[var(--brand)]"
                        checked={checked}
                        onChange={(e) =>
                          setSelected((prev) =>
                            e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1 text-start">
                        <span className="block truncate text-sm font-semibold text-[var(--ink)]">
                          {s.name}
                        </span>
                        <span className="block truncate text-xs text-[var(--ink-3)]">
                          {s.gradeLevel} · {s.parentName}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {saveRoster.isError ? <ErrorNote>{errorText(saveRoster.error)}</ErrorNote> : null}
        </div>
      </Modal>
    </div>
  );
}

export default Classes;
