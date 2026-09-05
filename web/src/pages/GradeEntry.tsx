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
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Badge, Button, Card, EmptyState, LoadingBlock, PageHeader } from "../components/ui";
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

/** Order-independent comparison; blank and whitespace count as the same value. */
function draftsEqual(a: Draft, b: Draft): boolean {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = a[key] ?? EMPTY_ROW;
    const right = b[key] ?? EMPTY_ROW;
    if (left.score.trim() !== right.score.trim()) return false;
    if (left.note.trim() !== right.note.trim()) return false;
  }
  return true;
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

/* ──────────────────────────────── stats ───────────────────────────────── */

function StatTile({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: string;
  tone?: "slate" | "blue" | "rose" | "amber";
}) {
  const toneClass = {
    slate: "text-slate-900",
    blue: "text-blue-700",
    rose: "text-rose-700",
    amber: "text-amber-600",
  }[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-2xl font-extrabold tabular-nums ${toneClass}`}>{value}</p>
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
        <Card>
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

  return (
    <div>
      <PageHeader
        title={assessment?.title ?? "إدخال الدرجات"}
        subtitle={subtitle}
        actions={
          <>
            <Link
              to="/grades"
              className="rounded-xl px-3 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100"
            >
              رجوع للاختبارات
            </Link>
            <Button onClick={submit} disabled={saveDisabled}>
              {save.isPending ? "جارٍ الحفظ…" : "حفظ الدرجات"}
            </Button>
          </>
        }
      />

      <div className="space-y-5">
        {notice ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            <span>
              تم حفظ {arNum(notice.saved)} درجة
              {notice.queued > 0
                ? ` · أُضيفت ${arNum(notice.queued)} رسالة تنبيه لأولياء الأمور إلى قائمة الإرسال`
                : " · لم تُضَف أي رسائل تنبيه"}
            </span>
            {notice.queued > 0 ? (
              <Link to="/messages" className="font-bold underline underline-offset-4">
                فتح قائمة الإرسال
              </Link>
            ) : null}
          </div>
        ) : null}

        {dirty ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-900">
            توجد تعديلات غير محفوظة — اضغط «حفظ الدرجات» قبل مغادرة الصفحة.
          </p>
        ) : null}

        {formError ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
            {formError}
          </p>
        ) : null}

        {detail.isLoading ? (
          <LoadingBlock />
        ) : detail.isError ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
            {errorMessage(detail.error)}
          </p>
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
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <StatTile label="عدد الطلاب" value={arNum(entries.length)} />
              <StatTile label="تم رصدها" value={arNum(summary.graded)} tone="blue" />
              <StatTile label="لم يؤدِّ الاختبار" value={arNum(summary.missed)} tone="amber" />
              <StatTile
                label="متوسط المجموعة"
                value={summary.average === null ? "—" : arPercent(summary.average)}
              />
              <StatTile
                label={`تحت ${arNum(threshold)}٪`}
                value={arNum(summary.low)}
                tone="rose"
              />
            </div>

            <Card bodyClassName="p-0">
              <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-xs font-bold text-slate-500">
                <span className="w-8 text-center">#</span>
                <span className="flex-1 text-start">الطالب</span>
                <span className="w-24 text-center">الدرجة</span>
                <span className="w-28 text-center">النسبة</span>
                <span className="hidden w-48 text-start md:block">ملاحظة</span>
              </div>

              <ul className="divide-y divide-slate-100">
                {entries.map((entry, index) => {
                  const row = draft[entry.studentId] ?? EMPTY_ROW;
                  const score = parseScore(row.score);
                  const missed = score === null;
                  const invalid =
                    score !== null &&
                    (Number.isNaN(score) || score < 0 || (maxScore > 0 && score > maxScore));
                  const percentage =
                    !missed && !invalid && maxScore > 0 ? ((score as number) / maxScore) * 100 : null;

                  return (
                    <li
                      key={entry.studentId}
                      className={`flex items-center gap-3 px-4 py-2.5 ${
                        missed ? "bg-slate-50/70" : "bg-white"
                      }`}
                    >
                      <span className="w-8 text-center text-sm tabular-nums text-slate-400">
                        {arNum(index + 1)}
                      </span>

                      <Link
                        to={`/students/${entry.studentId}`}
                        className="min-w-0 flex-1 truncate text-start font-semibold text-slate-800 hover:text-blue-700"
                      >
                        {entry.name}
                      </Link>

                      <input
                        ref={(el) => {
                          inputsRef.current[index] = el;
                        }}
                        type="number"
                        inputMode="decimal"
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
                        className={`w-24 rounded-xl border px-2 py-2 text-center text-base font-bold tabular-nums shadow-sm transition-colors focus:outline-none focus:ring-2 ${
                          invalid
                            ? "border-rose-400 bg-rose-50 text-rose-700 focus:border-rose-500 focus:ring-rose-500/30"
                            : "border-slate-300 focus:border-blue-500 focus:ring-blue-500/30"
                        }`}
                      />

                      <span className="flex w-28 justify-center">
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
                        className="hidden w-48 rounded-xl border border-slate-300 px-2 py-2 text-start text-sm shadow-sm transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 md:block"
                      />
                    </li>
                  );
                })}
              </ul>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-4 py-3">
                <p className="max-w-xl text-start text-xs leading-6 text-slate-500">
                  اترك الخانة فارغة لمن لم يؤدِّ الاختبار — لا تُحتسب في المتوسط ولا تُرسَل عنها
                  تنبيهات، وهي مختلفة تماماً عن الصفر. اضغط Enter للانتقال إلى الطالب التالي.
                </p>
                <Button onClick={submit} disabled={saveDisabled}>
                  {save.isPending ? "جارٍ الحفظ…" : "حفظ الدرجات"}
                </Button>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

export default GradeEntry;
