/**
 * /grades/:id — the score-entry grid.
 *
 * Built for one uninterrupted pass down a class list: type a score, press
 * Enter, land on the next student. Nothing is written until «حفظ الدرجات», so
 * the whole grid saves as a single request — and leaving with unsaved edits is
 * guarded, because re-typing thirty marks is not an acceptable accident.
 *
 * A blank input is *not* a zero: it means "لم يؤدِّ الاختبار" (`score: null`),
 * is excluded from the average, and never queues a low-grade alert. That
 * distinction is the whole point of this screen, so it is visible at every
 * level — placeholder, row tint and badge.
 *
 * On a phone the save control lives in a sticky bar pinned above the tab bar,
 * carrying the count of unsaved edits: the teacher scrolling row twenty-eight
 * of thirty must never have to scroll back up to find it.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, errorMessage } from "../api/client";
import type {
  AssessmentDetail,
  AssessmentEntry,
  GradeEntryInput,
  SaveResult,
  Settings,
} from "../api/types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingBlock,
  PageHeader,
  StatTile,
  cn,
} from "../components/ui";
import { ASSESSMENT_TYPE_AR, arDate, arNum, arPercent } from "../lib/format";

/** One row of the grid, kept as raw text so a half-typed "1" is never coerced. */
type RowDraft = { score: string; note: string };

type Draft = Record<string, RowDraft>;

const EMPTY_ROW: RowDraft = { score: "", note: "" };

const LEAVE_WARNING = "لديك درجات غير محفوظة. هل تريد الخروج من الصفحة دون حفظها؟";

/** Server default; only used until `GET /api/settings` answers. */
const FALLBACK_THRESHOLD = 60;

/* ─────────────────────────── draft <-> server ─────────────────────────── */

function toDraft(entries: AssessmentEntry[]): Draft {
  const draft: Draft = {};
  for (const entry of entries) {
    draft[entry.studentId] = {
      score: entry.score === null || entry.score === undefined ? "" : String(entry.score),
      note: entry.note ?? "",
    };
  }
  return draft;
}

/** True when the two rows carry the same value; blank and whitespace match. */
function rowsEqual(a: RowDraft, b: RowDraft): boolean {
  return a.score.trim() === b.score.trim() && a.note.trim() === b.note.trim();
}

/** Order-independent comparison; blank and whitespace count as the same value. */
function draftsEqual(a: Draft, b: Draft): boolean {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!rowsEqual(a[key] ?? EMPTY_ROW, b[key] ?? EMPTY_ROW)) return false;
  }
  return true;
}

/** How many students have an edit waiting — the number the sticky bar prints. */
function countChanges(a: Draft, b: Draft): number {
  let changed = 0;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!rowsEqual(a[key] ?? EMPTY_ROW, b[key] ?? EMPTY_ROW)) changed += 1;
  }
  return changed;
}

/** ١ تعديل · تعديلان · ٣ تعديلات · ١١ تعديلاً */
function changesLabel(count: number): string {
  if (count === 0) return "لا توجد تعديلات غير محفوظة";
  if (count === 1) return "تعديل واحد غير محفوظ";
  if (count === 2) return "تعديلان غير محفوظان";
  if (count <= 10) return `${arNum(count)} تعديلات غير محفوظة`;
  return `${arNum(count)} تعديلاً غير محفوظ`;
}

/** "" → null ("did not sit the test"); anything unparseable → NaN, caught by the validator. */
function parseScore(raw: string): number | null {
  const value = raw.trim();
  if (value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

/* ───────────────────────── unsaved-changes guard ──────────────────────── */

/**
 * `beforeunload` covers a reload or a closed tab. The capture-phase click
 * listener covers in-app links — the only other way off this page — because
 * react-router's `useBlocker` needs a data router and this app mounts a plain
 * <BrowserRouter>. Capturing on `document` runs before React's root listener,
 * so cancelling there stops the navigation entirely.
 *
 * This is why «رجوع للاختبارات» stays an <a>: routing it through `navigate()`
 * would slip straight past the guard.
 */
function useUnsavedChangesGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = LEAVE_WARNING;
    };

    const onClickCapture = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as HTMLElement | null)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank") return;

      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("/") || href === window.location.pathname) return;
      if (window.confirm(LEAVE_WARNING)) return;

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [active]);
}

/* ───────────────────────────── small pieces ───────────────────────────── */

/** A tinted block. Errors, warnings and confirmations all use this shape. */
function Note({
  tone,
  children,
}: {
  tone: "brand" | "late" | "absent";
  children: ReactNode;
}) {
  const skin = {
    brand: "bg-[var(--brand-soft)] text-[var(--ink)]",
    late: "bg-[var(--late-soft)] text-[var(--late-ink)]",
    absent: "bg-[var(--absent-soft)] text-[var(--absent-ink)]",
  }[tone];

  return (
    <div
      role={tone === "absent" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 text-start text-sm font-semibold",
        skin,
      )}
    >
      {children}
    </div>
  );
}

/* ─────────────────────────────── the page ─────────────────────────────── */

export function GradeEntry() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<Draft>({});
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState<SaveResult | null>(null);

  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);
  const loadedAtRef = useRef(0);
  /** The last payload the server sent, and a mirror of the live draft. */
  const serverDraftRef = useRef<Draft | null>(null);
  const draftRef = useRef<Draft>(draft);
  /** Set by a successful save: the next payload is ours, adopt it. */
  const adoptNextRef = useRef(false);

  draftRef.current = draft;

  const detail = useQuery({
    queryKey: ["assessment", id],
    queryFn: () => api.get<AssessmentDetail>(`/assessments/${id}`),
    enabled: id !== "",
  });

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/settings"),
  });

  const assessment = detail.data;
  const entries = useMemo(() => assessment?.entries ?? [], [assessment]);
  const maxScore = Number(assessment?.maxScore ?? 0);
  const threshold = Number(settings.data?.lowGradeThreshold ?? FALLBACK_THRESHOLD);

  /**
   * Adopts a new server payload on first load, and again after a save — where
   * the server copy *is* what we just sent. Everything else (a refetch on
   * window focus, a realtime "grade" event from another device) leaves the
   * draft alone: half-typed marks outrank a background refresh, always.
   */
  useEffect(() => {
    if (!detail.data || detail.dataUpdatedAt === loadedAtRef.current) return;
    loadedAtRef.current = detail.dataUpdatedAt;

    const incoming = toDraft(detail.data.entries);
    const unsaved =
      serverDraftRef.current !== null && !draftsEqual(draftRef.current, serverDraftRef.current);
    const adopt = adoptNextRef.current || !unsaved;

    adoptNextRef.current = false;
    serverDraftRef.current = incoming;
    if (adopt) setDraft(incoming);
  }, [detail.data, detail.dataUpdatedAt]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 12_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const baseline = useMemo(() => toDraft(entries), [entries]);

  const dirty = useMemo(() => !draftsEqual(baseline, draft), [baseline, draft]);
  const dirtyCount = useMemo(() => countChanges(baseline, draft), [baseline, draft]);

  useUnsavedChangesGuard(dirty);

  /** Running totals for the header — recomputed on every keystroke. */
  const summary = useMemo(() => {
    let graded = 0;
    let missed = 0;
    let low = 0;
    let invalid = 0;
    let total = 0;

    for (const entry of entries) {
      const score = parseScore(draft[entry.studentId]?.score ?? "");
      if (score === null) {
        missed += 1;
        continue;
      }
      if (Number.isNaN(score) || score < 0 || (maxScore > 0 && score > maxScore)) {
        invalid += 1;
        continue;
      }
      graded += 1;
      const percentage = maxScore > 0 ? (score / maxScore) * 100 : 0;
      total += percentage;
      if (percentage < threshold) low += 1;
    }

    return { graded, missed, low, invalid, average: graded > 0 ? total / graded : null };
  }, [draft, entries, maxScore, threshold]);

  const save = useMutation({
    mutationFn: (payload: { entries: GradeEntryInput[] }) =>
      api.post<SaveResult>(`/assessments/${id}/grades`, payload),
    onSuccess: (result) => {
      setFormError("");
      setNotice({ saved: result?.saved ?? 0, queued: result?.queued ?? 0 });
      // The refetch below now carries exactly what we sent — take it verbatim.
      adoptNextRef.current = true;
      queryClient.invalidateQueries({ queryKey: ["assessment", id] });
      queryClient.invalidateQueries({ queryKey: ["assessments"] });
      queryClient.invalidateQueries({ queryKey: ["students"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const submit = () => {
    if (maxScore <= 0) {
      setFormError("الدرجة الكاملة لهذا الاختبار غير صالحة — عدّلها من صفحة الدرجات أولاً.");
      return;
    }

    const payload: GradeEntryInput[] = [];
    for (const entry of entries) {
      const row = draft[entry.studentId] ?? EMPTY_ROW;
      const score = parseScore(row.score);

      if (score !== null && Number.isNaN(score)) {
        setFormError(`الدرجة المُدخَلة للطالب ${entry.name} ليست رقماً.`);
        return;
      }
      if (score !== null && (score < 0 || score > maxScore)) {
        setFormError(`درجة الطالب ${entry.name} يجب أن تكون بين ٠ و${arNum(maxScore)}.`);
        return;
      }

      payload.push({ studentId: entry.studentId, score, note: row.note.trim() || null });
    }

    setFormError("");
    setNotice(null);
    save.mutate({ entries: payload });
  };

  const setRow = (studentId: string, patch: Partial<RowDraft>) => {
    setDraft((current) => ({
      ...current,
      [studentId]: { ...(current[studentId] ?? EMPTY_ROW), ...patch },
    }));
  };

  /** Enter walks down the column — the fastest way through a printed mark sheet. */
  const focusNext = (index: number) => {
    for (let i = index + 1; i < inputsRef.current.length; i += 1) {
      const input = inputsRef.current[i];
      if (input) {
        input.focus();
        input.select();
        return;
      }
    }
    inputsRef.current[index]?.blur();
  };

  if (id === "") {
    return (
      <>
        <PageHeader title="إدخال الدرجات" />
        <Card bodyClassName="p-0">
          <EmptyState
            title="لم يتم تحديد الاختبار"
            hint="اختر اختباراً من صفحة الدرجات لإدخال درجات طلابه."
            action={
              <Button variant="secondary" onClick={() => navigate("/grades")}>
                صفحة الدرجات
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  const subtitle = assessment
    ? [
        assessment.classGroup?.name,
        ASSESSMENT_TYPE_AR[assessment.type] ?? assessment.type,
        assessment.date ? arDate(assessment.date) : null,
        `الدرجة الكاملة ${arNum(maxScore)}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  const saveDisabled = save.isPending || !dirty || summary.invalid > 0 || entries.length === 0;
  const saveLabel = save.isPending ? "جارٍ الحفظ…" : "حفظ الدرجات";

  return (
    <div>
      <PageHeader
        title={assessment?.title ?? "إدخال الدرجات"}
        subtitle={subtitle}
        actions={
          <>
            {/* Stays an <a> on purpose — see useUnsavedChangesGuard. */}
            <Link
              to="/grades"
              className={cn(
                "inline-flex h-11 select-none items-center justify-center rounded-2xl px-5 text-sm font-semibold",
                "text-[var(--ink-2)] transition-colors duration-150 hover:bg-[var(--surface-2)] hover:text-[var(--ink)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] sm:text-base",
              )}
            >
              رجوع للاختبارات
            </Link>
            {/* max-md: rather than hidden — Button already carries
                `inline-flex`, which sorts after `.hidden` and would win. */}
            <Button onClick={submit} disabled={saveDisabled} className="max-md:hidden">
              {saveLabel}
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        {notice ? (
          <Note tone="brand">
            <span>
              تم حفظ {arNum(notice.saved)} درجة
              {notice.queued > 0
                ? ` · أُضيفت ${arNum(notice.queued)} رسالة تنبيه لأولياء الأمور إلى قائمة الإرسال`
                : " · لم تُضَف أي رسائل تنبيه"}
            </span>
            {notice.queued > 0 ? (
              <Link
                to="/messages"
                className="font-semibold text-[var(--brand-ink)] underline underline-offset-4"
              >
                فتح قائمة الإرسال
              </Link>
            ) : null}
          </Note>
        ) : null}

        {dirty ? (
          <Note tone="late">
            <span>توجد تعديلات غير محفوظة — اضغط «حفظ الدرجات» قبل مغادرة الصفحة.</span>
          </Note>
        ) : null}

        {formError ? (
          <Note tone="absent">
            <span>{formError}</span>
          </Note>
        ) : null}

        {detail.isLoading ? (
          <Card bodyClassName="p-0">
            <LoadingBlock />
          </Card>
        ) : detail.isError ? (
          <Note tone="absent">
            <span>{errorMessage(detail.error)}</span>
          </Note>
        ) : entries.length === 0 ? (
          <Card bodyClassName="p-0">
            <EmptyState
              title="لا يوجد طلاب في هذه المجموعة"
              hint="أضف طلاباً إلى المجموعة من صفحة المجموعات ثم عُد لإدخال الدرجات."
              action={
                <Button variant="secondary" onClick={() => navigate("/classes")}>
                  إدارة المجموعات
                </Button>
              }
            />
          </Card>
        ) : (
          <>
            {/* The live picture of the sheet, recomputed on every keystroke. */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <StatTile
                label="متوسط المجموعة"
                value={summary.average === null ? "—" : arPercent(summary.average)}
                meter={summary.average ?? 0}
                hint={`من ${arNum(summary.graded)} درجة مرصودة`}
              />
              <StatTile
                label="تم رصدها"
                value={arNum(summary.graded)}
                hint={`من ${arNum(entries.length)} طالباً`}
              />
              <StatTile
                label="لم يؤدِّ الاختبار"
                value={arNum(summary.missed)}
                hint="لا تدخل في المتوسط"
              />
              <StatTile
                label={`تحت ${arNum(threshold)}٪`}
                value={arNum(summary.low)}
                hint="تُرسَل لهم تنبيهات المستوى"
              />
            </div>

            <Card bodyClassName="p-0">
              {/* Column headings only make sense once the row stops wrapping. */}
              <div className="hidden items-center gap-3 border-b border-[var(--border)] px-5 py-3 text-xs font-semibold text-[var(--ink-3)] md:flex">
                <span className="flex-1 text-start ps-9">الطالب</span>
                <span className="w-28 text-center">الدرجة</span>
                <span className="w-32 text-center">النسبة</span>
                {/* The sidebar eats 264px, so the note only earns its own
                    column once the viewport can actually spare one. */}
                <span className="hidden w-40 text-start lg:block xl:w-52">ملاحظة</span>
              </div>

              <ul className="divide-y divide-[var(--border)]">
                {entries.map((entry, index) => {
                  const row = draft[entry.studentId] ?? EMPTY_ROW;
                  const score = parseScore(row.score);
                  const missed = score === null;
                  const invalid =
                    score !== null &&
                    (Number.isNaN(score) || score < 0 || (maxScore > 0 && score > maxScore));
                  const percentage =
                    !missed && !invalid && maxScore > 0
                      ? ((score as number) / maxScore) * 100
                      : null;

                  return (
                    <li
                      key={entry.studentId}
                      className={cn(
                        "flex flex-wrap items-center gap-x-3 gap-y-2.5 px-4 py-3 sm:px-5",
                        // A blank score is a real state, not an empty cell.
                        missed && "bg-[var(--surface-2)]",
                      )}
                    >
                      <div className="flex min-w-0 basis-full items-center gap-3 md:flex-1 md:basis-auto">
                        <span className="w-6 shrink-0 text-center text-xs font-semibold tabular-nums text-[var(--ink-3)]">
                          {arNum(index + 1)}
                        </span>
                        <Link
                          to={`/students/${entry.studentId}`}
                          className="min-w-0 flex-1 truncate text-start text-sm font-semibold text-[var(--ink)] transition-colors duration-150 hover:text-[var(--brand-ink)]"
                        >
                          {entry.name}
                        </Link>
                      </div>

                      <input
                        ref={(el) => {
                          inputsRef.current[index] = el;
                        }}
                        type="number"
                        inputMode="decimal"
                        dir="ltr"
                        min={0}
                        max={maxScore > 0 ? maxScore : undefined}
                        step="any"
                        placeholder="—"
                        aria-label={`درجة ${entry.name}`}
                        aria-invalid={invalid || undefined}
                        value={row.score}
                        onChange={(e) => setRow(entry.studentId, { score: e.target.value })}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          focusNext(index);
                        }}
                        className={cn(
                          "h-11 w-24 shrink-0 rounded-2xl border bg-[var(--surface-2)] px-2 text-center text-lg font-bold tabular-nums text-[var(--ink)]",
                          "transition-colors duration-150 placeholder:font-normal placeholder:text-[var(--ink-3)] focus:outline-none focus:ring-2 sm:w-28",
                          invalid
                            ? "border-[var(--absent)] focus:border-[var(--absent)] focus:ring-[var(--absent-soft)]"
                            : "border-[var(--border)] hover:border-[var(--border-strong)] focus:border-[var(--brand)] focus:ring-[var(--brand-soft)]",
                        )}
                      />

                      <span className="flex min-w-0 flex-1 justify-start md:w-32 md:flex-none md:justify-center">
                        {invalid ? (
                          <Badge tone="red">خارج النطاق</Badge>
                        ) : missed ? (
                          <Badge tone="gray">لم يؤدِّ الاختبار</Badge>
                        ) : (
                          <Badge tone={(percentage ?? 0) < threshold ? "red" : "green"}>
                            {arPercent(percentage ?? 0)}
                          </Badge>
                        )}
                      </span>

                      <input
                        type="text"
                        placeholder="ملاحظة"
                        aria-label={`ملاحظة على درجة ${entry.name}`}
                        value={row.note}
                        onChange={(e) => setRow(entry.studentId, { note: e.target.value })}
                        className={cn(
                          "hidden h-11 w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-3 text-start text-sm text-[var(--ink)]",
                          "transition-colors duration-150 placeholder:text-[var(--ink-3)] hover:border-[var(--border-strong)]",
                          "focus:border-[var(--brand)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-soft)]",
                          // md is only ~440px of content next to the sidebar:
                          // the note drops to its own full-width line there and
                          // rejoins the row as a real column at lg.
                          "md:block md:basis-full lg:w-40 lg:basis-auto xl:w-52",
                        )}
                      />
                    </li>
                  );
                })}
              </ul>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-4 sm:px-5">
                <p className="max-w-xl text-start text-xs leading-6 text-[var(--ink-3)]">
                  اترك الخانة فارغة لمن لم يؤدِّ الاختبار — لا تُحتسب في المتوسط ولا تُرسَل عنها
                  تنبيهات، وهي مختلفة تماماً عن الصفر. اضغط Enter للانتقال إلى الطالب التالي.
                </p>
                {/* max-md: rather than hidden — Button already carries
                    `inline-flex`, which sorts after `.hidden` and would win. */}
                <Button onClick={submit} disabled={saveDisabled} className="max-md:hidden">
                  {saveLabel}
                </Button>
              </div>
            </Card>

            {/* ── Sticky save bar, phones only ───────────────────────────
                Pinned above the bottom tab bar (56px + the home indicator),
                so «حفظ الدرجات» is reachable from any row of the sheet. */}
            <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 -mt-2 bg-[var(--bg)] pb-1 pt-2 md:hidden">
              <div className="elev flex items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
                <p
                  className={cn(
                    "min-w-0 flex-1 text-start text-xs font-semibold",
                    dirtyCount > 0 ? "text-[var(--late-ink)]" : "text-[var(--ink-3)]",
                  )}
                >
                  {changesLabel(dirtyCount)}
                </p>
                <Button onClick={submit} disabled={saveDisabled} className="shrink-0">
                  {saveLabel}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default GradeEntry;
