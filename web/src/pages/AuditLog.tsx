import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, History, RotateCw, ShieldCheck } from "lucide-react";

import { api, buildQuery, errorMessage } from "../api/client";
import type { AuditEntry, User } from "../api/types";
import { useAuth } from "../lib/auth";
import {
  Badge,
  Button,
  Card,
  Dot,
  EmptyState,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  cn,
  type Tone,
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
 *  1. entries are grouped by day under sticky «اليوم» / «أمس» headers, so
 *     scanning starts from what happened an hour ago instead of a wall of
 *     timestamps;
 *  2. each action carries a dot in one of the four semantic colours *beside its
 *     Arabic name*, so a run of deletions is visible from across the room while
 *     colour never carries the meaning alone;
 *  3. expanding a row renders the before/after snapshots as an Arabic
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

/**
 * The dot beside each action. Deliberately not a rainbow: this reuses the four
 * semantic colours the whole app already means something by — green added, red
 * removed, amber changed, the accent for everything the app sent or recorded,
 * grey for bookkeeping.
 */
const ACTION_TONE: Record<string, Tone> = {
  CREATE: "green",
  UPDATE: "amber",
  DELETE: "red",
  MESSAGE: "brand",
  ATTENDANCE: "brand",
  GRADES: "brand",
  SETTINGS: "gray",
  LOGIN: "gray",
};

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

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-2xl border border-[var(--border)] bg-[var(--absent-soft)] px-4 py-3 text-start text-sm font-semibold leading-7 text-[var(--ink)]">
      {children}
    </p>
  );
}

/** One side of the comparison: a label over the value it held. */
function DiffCell({ heading, value, tone }: { heading: string; value: string; tone: Tone }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-start text-[11px] font-semibold text-[var(--ink-3)]">{heading}</p>
      <p
        dir="auto"
        className={cn(
          "break-words rounded-xl px-3 py-1.5 text-start text-sm leading-6 text-[var(--ink)]",
          tone === "red" ? "bg-[var(--absent-soft)]" : "bg-[var(--present-soft)]",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function DiffTable({ rows, heading }: { rows: DiffRow[]; heading: string }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl bg-[var(--surface)] px-4 py-2.5 text-start text-sm text-[var(--ink-2)]">
        لا توجد تفاصيل إضافية لهذا الإجراء.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-start text-xs font-semibold text-[var(--ink-3)]">{heading}</p>

      <div className="space-y-2">
        {rows.map((row) =>
          row.secret ? (
            <p
              key={row.key}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-start text-sm leading-6 text-[var(--ink-2)]"
            >
              تم تغيير <span className="font-semibold text-[var(--ink)]">{row.label}</span> —
              القيمة لا تُعرض أبداً.
            </p>
          ) : (
            <div
              key={row.key}
              className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:grid-cols-[9rem_1fr_1fr] sm:items-start"
            >
              <span className="pt-1 text-start text-xs font-semibold text-[var(--ink-2)]">
                {row.label}
              </span>
              <DiffCell heading="قبل" value={row.before} tone="red" />
              <DiffCell heading="بعد" value={row.after} tone="green" />
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
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "flex w-full items-start gap-3 px-5 py-3.5 text-start transition-colors duration-150 hover:bg-[var(--surface-2)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)]",
          expanded && "bg-[var(--surface-2)]",
        )}
      >
        <span className="tnum mt-0.5 w-14 shrink-0 text-start text-xs font-semibold text-[var(--ink-3)]">
          {clockOf(entry.createdAt)}
        </span>

        <span className="mt-1.5 shrink-0">
          <Dot tone={ACTION_TONE[action] ?? "gray"} />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-6 text-[var(--ink)]">{entry.summary ?? ""}</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--ink-3)]">
            <span className="font-semibold text-[var(--ink-2)]">
              {entry.userName || "مستخدم محذوف"}
            </span>
            <Badge tone={String(entry.userRole ?? "") === "OWNER" ? "brand" : "gray"}>
              {ROLE_AR[String(entry.userRole ?? "")] ?? String(entry.userRole ?? "")}
            </Badge>
            <span aria-hidden>·</span>
            <span>{ACTION_AR[action] ?? action ?? "إجراء"}</span>
            <span aria-hidden>·</span>
            <span>{ENTITY_AR[String(entry.entity ?? "")] ?? String(entry.entity ?? "")}</span>
          </span>
        </span>

        <ChevronDown
          aria-hidden
          className={cn(
            "mt-1 h-4 w-4 shrink-0 text-[var(--ink-3)] transition-transform duration-150",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded ? (
        <div className="border-t border-[var(--border)] bg-[var(--surface-2)] px-5 py-4 sm:ps-[4.75rem]">
          <DiffTable rows={diff} heading={heading} />

          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-start text-[11px] text-[var(--ink-3)]">
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
        <Card bodyClassName="p-0">
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
        subtitle={`${arNum(filtered.length)} إجراء معروض${hasFilters ? " بعد التصفية" : ""}`}
        actions={
          <Button variant="secondary" size="sm" onClick={() => void audit.refetch()}>
            <RotateCw className={cn("h-4 w-4", isBusy && "animate-spin")} aria-hidden />
            تحديث
          </Button>
        }
      />

      <div className="space-y-6">
        {/* ── Filters ─────────────────────────────────────────────────── */}
        <Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

            <Input
              label="إلى تاريخ"
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                resetLimit();
              }}
            />
          </div>

          {hasFilters ? (
            <div className="mt-4 flex justify-start">
              <Button
                variant="ghost"
                size="sm"
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
            </div>
          ) : null}
        </Card>

        {/* ── The trail ───────────────────────────────────────────────── */}
        {audit.isLoading ? (
          <Card>
            <LoadingBlock />
          </Card>
        ) : audit.isError ? (
          <ErrorLine>{errorMessage(audit.error)}</ErrorLine>
        ) : groups.length === 0 ? (
          <Card bodyClassName="p-0">
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
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.key || "unknown"}>
                {/* The mobile shell keeps a 59px bar pinned at the top, so the
                    day header parks just under it and sits flush on desktop. */}
                <div className="sticky top-14 z-20 mb-3 flex items-center gap-3 bg-[var(--bg)] py-2 md:top-0">
                  <h2 className="text-start text-sm font-semibold text-[var(--ink)]">
                    {group.label}
                  </h2>
                  <span className="text-xs text-[var(--ink-3)]">
                    {arNum(group.entries.length)} إجراء
                  </span>
                  <span className="h-px flex-1 bg-[var(--border)]" aria-hidden />
                </div>

                <Card bodyClassName="p-0">
                  <ul className="divide-y divide-[var(--border)]">
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
                <p className="text-xs text-[var(--ink-3)]">وصلت إلى بداية السجل</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AuditLog;
