import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, History, RotateCw, ShieldCheck } from "lucide-react";

import { api, buildQuery, errorMessage } from "../api/client";
import type { AuditEntry, User } from "../api/types";
import { useAuth } from "../lib/auth";
import {
  Button,
  Card,
  EmptyState,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  cn,
} from "../components/ui";
import {
  ASSESSMENT_TYPE_AR,
  MESSAGE_STATUS_AR,
  SESSION_STATUS_AR,
  STATUS_AR,
  addDaysISO,
  arDate,
  arDateTime,
  arNum,
  arTime,
  todayISO,
} from "../lib/format";

/**
 * OWNER-only activity trail — the answer to "من غيّر هذا؟".
 *
 * Three things make it worth reading rather than merely correct:
 *  1. entries are grouped by day with «اليوم» / «أمس» headers, so scanning
 *     starts from what happened an hour ago instead of a wall of timestamps;
 *  2. the action is colour-coded, so a row of deletions is visible from across
 *     the room;
 *  3. expanding a row renders the before/after JSON snapshots as an Arabic
 *     field-by-field diff of *changed fields only* — never a raw JSON dump.
 *
 * Anything that looks like a credential (password, hash, token, secret) is
 * masked, including keys nested inside `providerConfig`.
 */

const PAGE_SIZE = 60;
const DASH = "—";
const MASK = "••••••";

/* ─────────────────────────── Arabic vocabulary ────────────────────────── */

const ACTION_AR: Record<string, string> = {
  LOGIN: "تسجيل دخول",
  CREATE: "إضافة",
  UPDATE: "تعديل",
  DELETE: "حذف",
  ATTENDANCE: "حضور",
  GRADES: "درجات",
  MESSAGE: "رسالة",
  SETTINGS: "إعدادات",
};

const ENTITY_AR: Record<string, string> = {
  Student: "طالب",
  ClassGroup: "مجموعة",
  Session: "حصة",
  Attendance: "تسجيل حضور",
  Assessment: "تقييم",
  Grade: "درجة",
  Message: "رسالة",
  MessageTemplate: "قالب رسالة",
  Setting: "إعدادات",
  User: "مستخدم",
};

const ROLE_AR: Record<string, string> = {
  OWNER: "مالك",
  ASSISTANT: "مساعد",
};

/** Chip colours: green create · amber update · red delete · blue message · gray login. */
const ACTION_CHIP: Record<string, string> = {
  CREATE: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  UPDATE: "bg-amber-50 text-amber-700 ring-amber-200",
  DELETE: "bg-rose-50 text-rose-700 ring-rose-200",
  MESSAGE: "bg-blue-50 text-blue-700 ring-blue-200",
  LOGIN: "bg-slate-100 text-slate-600 ring-slate-200",
  ATTENDANCE: "bg-violet-50 text-violet-700 ring-violet-200",
  GRADES: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  SETTINGS: "bg-teal-50 text-teal-700 ring-teal-200",
};

const ACTION_STRIPE: Record<string, string> = {
  CREATE: "bg-emerald-400",
  UPDATE: "bg-amber-400",
  DELETE: "bg-rose-400",
  MESSAGE: "bg-blue-400",
  LOGIN: "bg-slate-300",
  ATTENDANCE: "bg-violet-400",
  GRADES: "bg-indigo-400",
  SETTINGS: "bg-teal-400",
};

const CHIP_FALLBACK = "bg-slate-100 text-slate-600 ring-slate-200";
const STRIPE_FALLBACK = "bg-slate-300";

/** Column names as the teacher knows them, not as Prisma spells them. */
const FIELD_AR: Record<string, string> = {
  value: "القيمة",
  name: "الاسم",
  parentName: "ولي الأمر",
  parentPhone: "هاتف ولي الأمر",
  altPhone: "رقم بديل",
  gradeLevel: "المرحلة الدراسية",
  notes: "ملاحظات",
  note: "ملاحظة",
  isActive: "نشط",
  subject: "المادة",
  color: "اللون",
  slots: "مواعيد الأسبوع",
  weekday: "اليوم",
  startTime: "وقت البدء",
  endTime: "وقت الانتهاء",
  location: "المكان",
  date: "التاريخ",
  topic: "الموضوع",
  status: "الحالة",
  minutesLate: "دقائق التأخير",
  title: "العنوان",
  type: "النوع",
  maxScore: "الدرجة العظمى",
  weight: "الوزن النسبي",
  score: "الدرجة",
  percentage: "النسبة",
  body: "نص الرسالة",
  toPhone: "رقم المرسَل إليه",
  channel: "القناة",
  templateKey: "نوع الرسالة",
  sentAt: "وقت الإرسال",
  attempts: "عدد المحاولات",
  error: "سبب الفشل",
  dedupeKey: "مفتاح منع التكرار",
  provider: "مزوّد الإرسال",
  providerConfig: "إعدادات المزوّد",
  lowGradeThreshold: "حد الدرجة المنخفضة",
  autoSendAbsence: "إرسال تنبيه الغياب تلقائياً",
  autoSendLate: "إرسال تنبيه التأخير تلقائياً",
  autoSendLowGrade: "إرسال تنبيه الدرجة تلقائياً",
  quietHoursStart: "بداية فترة الصمت",
  quietHoursEnd: "نهاية فترة الصمت",
  tutorName: "اسم المعلّم",
  centerName: "اسم المركز",
  defaultCountryCode: "كود الدولة",
  username: "اسم المستخدم",
  role: "الصلاحية",
  password: "كلمة المرور",
  passwordHash: "كلمة المرور",
  lastLoginAt: "آخر دخول",
  studentId: "الطالب",
  studentIds: "الطلاب",
  classGroupId: "المجموعة",
  sessionId: "الحصة",
  assessmentId: "التقييم",
  marks: "تسجيلات الحضور",
  entries: "الدرجات",
  ip: "عنوان الجهاز",
};

/** Enum tokens that can appear as a value inside a snapshot. */
const ENUM_AR: Record<string, string> = {
  ...STATUS_AR,
  ...SESSION_STATUS_AR,
  ...ASSESSMENT_TYPE_AR,
  ...MESSAGE_STATUS_AR,
  OWNER: "مالك",
  ASSISTANT: "مساعد",
  WA_LINK: "روابط واتساب",
  GREEN_API: "Green API",
  TWILIO: "Twilio",
  WHATSAPP: "واتساب",
  SMS: "رسالة نصية",
  ABSENCE: "تنبيه غياب",
  LOW_GRADE: "تنبيه مستوى",
  MONTHLY_REPORT: "التقرير الشهري",
  CUSTOM: "رسالة مخصّصة",
};

/** Never rendered, at any nesting depth. */
const SECRET_FIELD = /pass|hash|token|secret|credential/i;
/** Bookkeeping columns nobody audits. */
const NOISE_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

/* ───────────────────────────── value helpers ──────────────────────────── */

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_FIELD.test(key) ? MASK : redact(nested);
    }
    return out;
  }
  return value;
}

/** Formats any snapshot value for display. Never returns "undefined". */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return DASH;
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (typeof value === "number") return Number.isFinite(value) ? arNum(value) : DASH;

  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return DASH;
    const known = ENUM_AR[text];
    if (known) return known;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return arDate(text);
    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return arDateTime(text);
    if (/^\d{1,2}:\d{2}$/.test(text)) return arTime(text);
    return text;
  }

  try {
    const json = JSON.stringify(redact(value));
    if (!json || json === "{}" || json === "[]") return DASH;
    return json.length > 220 ? `${json.slice(0, 220)}…` : json;
  } catch {
    return DASH;
  }
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Turns a snapshot column into an object. The column is documented as a JSON
 * string, but a server that already parsed it is handled too, and anything
 * unparseable degrades to a single «القيمة» row instead of blowing up.
 */
function parseSnapshot(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "object") {
    if (Array.isArray(value)) return { value };
    return value as Record<string, unknown>;
  }

  if (typeof value !== "string") return { value };
  const text = value.trim();
  if (text === "") return null;

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null) return null;
    if (typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { value: text };
  }
}

interface DiffRow {
  key: string;
  label: string;
  secret: boolean;
  before: string;
  after: string;
}

/**
 * Changed fields only. When one side is missing (a create or a delete) every
 * populated field of the surviving side is listed instead.
 */
function buildDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): DiffRow[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of [...Object.keys(after ?? {}), ...Object.keys(before ?? {})]) {
    if (seen.has(key) || NOISE_FIELDS.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }

  const bothSides = before !== null && after !== null;
  const rows: DiffRow[] = [];

  for (const key of keys) {
    const beforeValue = before ? before[key] : undefined;
    const afterValue = after ? after[key] : undefined;
    if (bothSides && sameValue(beforeValue, afterValue)) continue;

    const secret = SECRET_FIELD.test(key);
    const beforeText = secret ? MASK : formatValue(beforeValue);
    const afterText = secret ? MASK : formatValue(afterValue);
    if (!bothSides && beforeText === DASH && afterText === DASH) continue;

    rows.push({ key, label: FIELD_AR[key] ?? key, secret, before: beforeText, after: afterText });
  }

  return rows;
}

/* ───────────────────────────── time helpers ───────────────────────────── */

const CLOCK_FORMAT = new Intl.DateTimeFormat("ar-EG", {
  hour: "numeric",
  minute: "2-digit",
});

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A real timestamp → the local calendar day it belongs to, "YYYY-MM-DD". */
function dayKeyOf(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clockOf(value: string | null | undefined): string {
  if (!value) return DASH;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? DASH : CLOCK_FORMAT.format(d);
}

function dayLabel(dayKey: string): string {
  if (dayKey === "") return "بدون تاريخ";
  const today = todayISO();
  if (dayKey === today) return "اليوم";
  if (dayKey === addDaysISO(today, -1)) return "أمس";
  return arDate(dayKey);
}

/* ───────────────────────────── payload shape ──────────────────────────── */

const LIST_KEYS = ["entries", "items", "rows", "data"] as const;

/** `GET /api/audit` may answer with a bare array or an envelope; accept both. */
function readEntries(payload: unknown): AuditEntry[] {
  if (Array.isArray(payload)) return payload as AuditEntry[];
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    for (const key of LIST_KEYS) {
      const value = record[key];
      if (Array.isArray(value)) return value as AuditEntry[];
    }
  }
  return [];
}

interface DayGroup {
  key: string;
  label: string;
  entries: AuditEntry[];
}

/* ─────────────────────────────── the row ──────────────────────────────── */

function RoleChip({ role }: { role: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
        role === "OWNER"
          ? "bg-blue-50 text-blue-700 ring-blue-200"
          : "bg-slate-100 text-slate-500 ring-slate-200",
      )}
    >
      {ROLE_AR[role] ?? role}
    </span>
  );
}

function DiffTable({ rows, heading }: { rows: DiffRow[]; heading: string }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg bg-white px-3 py-2 text-sm text-slate-500">
        لا توجد تفاصيل إضافية لهذا الإجراء.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-bold text-slate-500">{heading}</p>

      <div className="hidden gap-2 px-1 text-[11px] font-bold text-slate-400 sm:grid sm:grid-cols-[9rem_1fr_1fr]">
        <span>الحقل</span>
        <span>قبل</span>
        <span>بعد</span>
      </div>

      <div className="space-y-2">
        {rows.map((row) =>
          row.secret ? (
            <p
              key={row.key}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600"
            >
              تم تغيير <span className="font-bold text-slate-800">{row.label}</span> — القيمة لا
              تُعرض أبداً.
            </p>
          ) : (
            <div
              key={row.key}
              className="grid gap-2 rounded-lg border border-slate-200 bg-white p-2 sm:grid-cols-[9rem_1fr_1fr] sm:items-start"
            >
              <span className="px-1 pt-1 text-xs font-bold text-slate-600">{row.label}</span>

              <div>
                <p className="mb-0.5 px-1 text-[11px] font-semibold text-slate-400 sm:hidden">
                  قبل
                </p>
                <p
                  dir="auto"
                  className="break-words rounded-md bg-rose-50 px-2 py-1 text-sm leading-6 text-rose-800"
                >
                  {row.before}
                </p>
              </div>

              <div>
                <p className="mb-0.5 px-1 text-[11px] font-semibold text-slate-400 sm:hidden">
                  بعد
                </p>
                <p
                  dir="auto"
                  className="break-words rounded-md bg-emerald-50 px-2 py-1 text-sm leading-6 text-emerald-800"
                >
                  {row.after}
                </p>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: AuditEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const action = String(entry.action ?? "");
  const before = parseSnapshot(entry.before);
  const after = parseSnapshot(entry.after);
  const diff = buildDiff(before, after);
  const heading =
    before === null && after !== null
      ? "القيم الجديدة"
      : after === null && before !== null
        ? "القيم قبل الحذف"
        : "الحقول التي تغيّرت";

  return (
    <li className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-3 text-start transition-colors hover:bg-slate-50",
          expanded && "bg-slate-50",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mt-1 h-8 w-1 shrink-0 rounded-full",
            ACTION_STRIPE[action] ?? STRIPE_FALLBACK,
          )}
        />

        <span className="mt-0.5 w-14 shrink-0 text-xs font-semibold tabular-nums text-slate-500">
          {clockOf(entry.createdAt)}
        </span>

        <span
          className={cn(
            "mt-0.5 shrink-0 rounded-lg px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
            ACTION_CHIP[action] ?? CHIP_FALLBACK,
          )}
        >
          {ACTION_AR[action] ?? action ?? "إجراء"}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-6 text-slate-800">
            {entry.summary ?? ""}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            <span className="font-semibold text-slate-600">{entry.userName || "مستخدم محذوف"}</span>
            <RoleChip role={String(entry.userRole ?? "")} />
            <span className="text-slate-300">·</span>
            <span>{ENTITY_AR[String(entry.entity ?? "")] ?? String(entry.entity ?? "")}</span>
          </span>
        </span>

        <ChevronDown
          aria-hidden
          className={cn(
            "mt-1 h-4 w-4 shrink-0 text-slate-400 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded ? (
        <div className="border-t border-slate-100 bg-slate-50 px-3 py-3 sm:ps-20">
          <DiffTable rows={diff} heading={heading} />

          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
            <span>{arDateTime(entry.createdAt)}</span>
            {entry.entityId ? (
              <span dir="ltr" className="font-mono">
                #{entry.entityId}
              </span>
            ) : null}
            {entry.ip ? (
              <span dir="ltr" className="font-mono">
                {entry.ip}
              </span>
            ) : null}
          </p>
        </div>
      ) : null}
    </li>
  );
}

/* ─────────────────────────────── the page ─────────────────────────────── */

export function AuditLog() {
  const { isOwner } = useAuth();

  const [userId, setUserId] = useState("");
  const [action, setAction] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Typing in the search box should not fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setLimit(PAGE_SIZE);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<User[]>("/users"),
    enabled: isOwner,
  });

  const audit = useQuery({
    queryKey: ["audit", { userId, action, entity, from, to, q: search, limit }],
    queryFn: () =>
      api.get<unknown>(
        `/audit${buildQuery({ userId, action, entity, from, to, q: search, limit })}`,
      ),
    enabled: isOwner,
    // Keeps the current page on screen while the next one loads, so «تحميل
    // المزيد» never blanks the list the teacher is reading.
    placeholderData: keepPreviousData,
  });

  const entries = useMemo(() => readEntries(audit.data), [audit.data]);

  /**
   * The same predicates the server applies, re-applied locally: it keeps the
   * screen honest if an older server build ignores a query parameter.
   */
  const filtered = useMemo(() => {
    const needle = search;
    return entries.filter((entry) => {
      if (userId && entry.userId !== userId) return false;
      if (action && entry.action !== action) return false;
      if (entity && entry.entity !== entity) return false;

      const day = dayKeyOf(entry.createdAt);
      if (from && day && day < from) return false;
      if (to && day && day > to) return false;

      if (needle) {
        const haystack = `${entry.summary ?? ""} ${entry.userName ?? ""} ${
          ENTITY_AR[String(entry.entity ?? "")] ?? ""
        } ${ACTION_AR[String(entry.action ?? "")] ?? ""}`;
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [entries, userId, action, entity, from, to, search]);

  const groups = useMemo<DayGroup[]>(() => {
    const sorted = [...filtered].sort((a, b) =>
      String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
    );
    const out: DayGroup[] = [];
    let current: DayGroup | null = null;
    for (const entry of sorted) {
      const key = dayKeyOf(entry.createdAt);
      if (current === null || current.key !== key) {
        current = { key, label: dayLabel(key), entries: [] };
        out.push(current);
      }
      current.entries.push(entry);
    }
    return out;
  }, [filtered]);

  // A full page came back, so there is probably more behind it. When the server
  // caps `limit`, the next page returns short and the button disappears by itself.
  const canLoadMore = entries.length >= limit;
  const isBusy = audit.isFetching;

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !canLoadMore || isBusy) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          setLimit((current) => current + PAGE_SIZE);
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [canLoadMore, isBusy]);

  const resetLimit = () => setLimit(PAGE_SIZE);

  const hasFilters =
    userId !== "" || action !== "" || entity !== "" || from !== "" || to !== "" || search !== "";

  /** Owners of the accounts that can appear in the log. */
  const userOptions = useMemo(() => {
    const list = users.data ?? [];
    if (list.length > 0) {
      return list.map((row) => ({ id: row.id, name: row.name || row.username }));
    }
    const seen = new Map<string, string>();
    for (const entry of entries) {
      if (entry.userId && !seen.has(entry.userId)) {
        seen.set(entry.userId, entry.userName || "مستخدم");
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [users.data, entries]);

  if (!isOwner) {
    return (
      <div>
        <PageHeader title="سجلّ النشاط" />
        <Card>
          <EmptyState
            icon={<ShieldCheck className="h-6 w-6" />}
            title="هذه الصفحة للمالك فقط"
            hint="يمكنك متابعة عملك في الطلاب والحضور والدرجات والرسائل كالمعتاد."
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="سجلّ النشاط"
        subtitle={`${arNum(filtered.length)} إجراء معروض${
          hasFilters ? " بعد التصفية" : ""
        }`}
        actions={
          <Button variant="secondary" size="sm" onClick={() => void audit.refetch()}>
            <RotateCw className={cn("h-4 w-4", isBusy && "animate-spin")} />
            تحديث
          </Button>
        }
      />

      <div className="space-y-4">
        {/* ── Filters ─────────────────────────────────────────────────── */}
        <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-3">
          <Input
            label="بحث في السجل"
            placeholder="اسم طالب، كلمة في الوصف…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />

          <Select
            label="المستخدم"
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value);
              resetLimit();
            }}
          >
            <option value="">كل المستخدمين</option>
            {userOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </Select>

          <Select
            label="نوع الإجراء"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              resetLimit();
            }}
          >
            <option value="">كل الإجراءات</option>
            {Object.entries(ACTION_AR).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>

          <Select
            label="النوع"
            value={entity}
            onChange={(e) => {
              setEntity(e.target.value);
              resetLimit();
            }}
          >
            <option value="">كل الأنواع</option>
            {Object.entries(ENTITY_AR).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>

          <Input
            label="من تاريخ"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              resetLimit();
            }}
          />

          <div className="flex items-end gap-2">
            <Input
              label="إلى تاريخ"
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                resetLimit();
              }}
            />
            {hasFilters ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setUserId("");
                  setAction("");
                  setEntity("");
                  setFrom("");
                  setTo("");
                  setSearchInput("");
                  setSearch("");
                  resetLimit();
                }}
              >
                مسح
              </Button>
            ) : null}
          </div>
        </div>

        {/* ── The trail ───────────────────────────────────────────────── */}
        {audit.isLoading ? (
          <Card>
            <LoadingBlock />
          </Card>
        ) : audit.isError ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
            {errorMessage(audit.error)}
          </p>
        ) : groups.length === 0 ? (
          <Card>
            <EmptyState
              icon={<History className="h-6 w-6" />}
              title={hasFilters ? "لا نتائج مطابقة" : "السجل فارغ حتى الآن"}
              hint={
                hasFilters
                  ? "جرّب توسيع المدة الزمنية أو مسح بعض الفلاتر."
                  : "يُسجَّل هنا كل إجراء: تسجيل الدخول، إضافة طالب، حفظ الحضور، تعديل الدرجات، إرسال رسالة."
              }
            />
          </Card>
        ) : (
          <div className="space-y-5">
            {groups.map((group) => (
              <section key={group.key || "unknown"}>
                <div className="mb-2 flex items-center gap-3">
                  <h2 className="text-sm font-bold text-slate-700">{group.label}</h2>
                  <span className="text-xs text-slate-400">
                    {arNum(group.entries.length)} إجراء
                  </span>
                  <span className="h-px flex-1 bg-slate-200" aria-hidden />
                </div>

                <Card bodyClassName="p-0">
                  <ul className="divide-y divide-slate-100">
                    {group.entries.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        expanded={expandedId === entry.id}
                        onToggle={() =>
                          setExpandedId((current) => (current === entry.id ? null : entry.id))
                        }
                      />
                    ))}
                  </ul>
                </Card>
              </section>
            ))}

            <div ref={sentinelRef} className="flex justify-center pb-2">
              {canLoadMore ? (
                <Button
                  variant="secondary"
                  disabled={isBusy}
                  onClick={() => setLimit((current) => current + PAGE_SIZE)}
                >
                  {isBusy ? "جارٍ التحميل…" : "تحميل المزيد"}
                </Button>
              ) : (
                <p className="text-xs text-slate-400">وصلت إلى بداية السجل</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AuditLog;
