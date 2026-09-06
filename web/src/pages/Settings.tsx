/**
 * /settings — everything the teacher can change without a developer.
 *
 * Five independent sections, each responsible for its own state: general
 * options, the messaging provider, the Arabic templates, the account password,
 * and the appearance of the app itself. Saving is per-section on purpose — a
 * half-typed Green API token must never be able to block a change to the
 * low-grade threshold, and every section maps to a different endpoint anyway.
 *
 * Each Save stays disabled until that section is actually dirty, so the screen
 * tells you at a glance whether anything is still unsaved. «المظهر» is the one
 * section with no Save button: a theme applies the instant it is chosen and is
 * remembered on the device, not on the server.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Moon, Sun } from "lucide-react";

import { api, errorMessage } from "../api/client";
import type {
  MessageTemplate,
  PreviewResult,
  ProviderName,
  Settings as SettingsData,
} from "../api/types";
import {
  Badge,
  Button,
  Card,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Textarea,
  cn,
} from "../components/ui";
import { arDate, arMonth, arNum, arTime, currentMonthISO, todayISO } from "../lib/format";
import { openWhatsapp } from "../lib/openExternal";
import { useTheme, type Theme } from "../lib/theme";

/* ──────────────────────────────── shapes ──────────────────────────────── */

/** Credentials are edited as plain strings and trimmed on save. */
type CredentialsForm = {
  idInstance: string;
  apiTokenInstance: string;
  apiUrl: string;
  accountSid: string;
  authToken: string;
  from: string;
  channel: string;
};

type GeneralForm = {
  tutorName: string;
  centerName: string;
  defaultCountryCode: string;
  lowGradeThreshold: string;
  autoSendAbsence: boolean;
  autoSendLate: boolean;
  autoSendLowGrade: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
};

type ProviderForm = { provider: ProviderName; config: CredentialsForm };

type TemplateDraft = { name: string; body: string; isActive: boolean };

type PasswordForm = { current: string; next: string; confirm: string };

/** `POST /api/settings/test` — mirrors `TestProviderResult` on the server. */
type TestResult = {
  ok: boolean;
  provider: string;
  autonomous: boolean;
  toPhone: string;
  body: string;
  waLink?: string;
  /** The `whatsapp://` twin — the only form that reaches the app in the APK. */
  waAppLink?: string;
  error?: string;
  message: string;
};

const EMPTY_PASSWORD: PasswordForm = { current: "", next: "", confirm: "" };

/** Mirrors `PASSWORD_MIN_LENGTH` in server/src/services/auth.service.ts. */
const PASSWORD_MIN_LENGTH = 6;

const PROVIDERS: { value: ProviderName; label: string; hint: string }[] = [
  {
    value: "WA_LINK",
    label: "روابط واتساب — الافتراضي، بدون أي بيانات اعتماد",
    hint: "مجاني تماماً وبلا أي مخاطرة: تفتح الرسالة في واتساب وتضغط إرسال بنفسك من قائمة الإرسال.",
  },
  {
    value: "GREEN_API",
    label: "Green API — إرسال تلقائي من رقمك",
    hint: "يرسل من رقمك تلقائياً بعد ربط الجهاز بمسح رمز QR في green-api.com.",
  },
  {
    value: "TWILIO",
    label: "Twilio — رسمي، واتساب معتمد أو رسائل SMS",
    hint: "يتطلب حساب أعمال معتمداً وقوالب موافَقاً عليها من واتساب، وتكلفة لكل رسالة.",
  },
];

const TEMPLATE_NAME_AR: Record<string, string> = {
  ABSENCE: "تنبيه غياب",
  LATE: "تنبيه تأخير",
  LOW_GRADE: "تنبيه مستوى",
  MONTHLY_REPORT: "التقرير الشهري",
  CUSTOM: "رسالة مخصّصة",
};

/* ────────────────────────── server ⇄ form mapping ─────────────────────── */

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function toGeneralForm(settings: SettingsData): GeneralForm {
  return {
    tutorName: settings.tutorName ?? "",
    centerName: settings.centerName ?? "",
    defaultCountryCode: settings.defaultCountryCode || "+20",
    lowGradeThreshold: String(settings.lowGradeThreshold ?? 60),
    autoSendAbsence: settings.autoSendAbsence !== false,
    autoSendLate: settings.autoSendLate === true,
    autoSendLowGrade: settings.autoSendLowGrade !== false,
    quietHoursStart: settings.quietHoursStart || "22:00",
    quietHoursEnd: settings.quietHoursEnd || "08:00",
  };
}

function toProviderForm(settings: SettingsData): ProviderForm {
  const config = (settings.providerConfig ?? {}) as Record<string, unknown>;
  return {
    provider: (settings.provider ?? "WA_LINK") as ProviderName,
    config: {
      idInstance: readString(config, "idInstance"),
      apiTokenInstance: readString(config, "apiTokenInstance"),
      apiUrl: readString(config, "apiUrl"),
      accountSid: readString(config, "accountSid"),
      authToken: readString(config, "authToken"),
      from: readString(config, "from"),
      channel: readString(config, "channel") || "WHATSAPP",
    },
  };
}

/**
 * Every credential that has a value is persisted, not just the active
 * provider's: switching to روابط واتساب and back must not wipe a working Green
 * API token. The adapters ignore keys that are not theirs.
 */
function toProviderConfig(form: ProviderForm): Record<string, string> {
  const config: Record<string, string> = {};
  const keep = (key: keyof CredentialsForm) => {
    const value = (form.config[key] ?? "").trim();
    if (value) config[key] = value;
  };
  keep("idInstance");
  keep("apiTokenInstance");
  keep("apiUrl");
  keep("accountSid");
  keep("authToken");
  keep("from");
  if (config.accountSid || config.authToken || config.from) {
    config.channel = form.config.channel || "WHATSAPP";
  }
  return config;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/* ─────────────────────────── local template render ────────────────────── */

/** Mirrors `render()` in server/src/messaging/template.ts. */
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(PLACEHOLDER, (_match, key: string) => vars[key] ?? "");
}

/* ────────────────────────────── small parts ───────────────────────────── */

/** A notice that clears itself, so no section keeps a stale "تم الحفظ". */
function useTransientNotice(): [string, (value: string) => void] {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (!value) return;
    const timer = window.setTimeout(() => setValue(""), 6000);
    return () => window.clearTimeout(timer);
  }, [value]);
  return [value, setValue];
}

function SaveAction({
  dirty,
  pending,
  notice,
  onSave,
}: {
  dirty: boolean;
  pending: boolean;
  notice: string;
  onSave: () => void;
}) {
  return (
    <>
      {notice ? (
        <span className="text-xs font-semibold text-[var(--present-ink)] sm:text-sm">
          {notice}
        </span>
      ) : dirty ? (
        <span className="text-xs font-semibold text-[var(--late-ink)] sm:text-sm">
          تغييرات غير محفوظة
        </span>
      ) : null}
      <Button size="sm" onClick={onSave} disabled={!dirty || pending}>
        {pending ? "جارٍ الحفظ…" : "حفظ"}
      </Button>
    </>
  );
}

/** Every failure on this screen looks the same: one tinted line, Arabic first. */
function ErrorLine({ error }: { error: unknown }) {
  return (
    <p className="rounded-2xl border border-[var(--border)] bg-[var(--absent-soft)] px-4 py-3 text-start text-sm font-semibold leading-7 text-[var(--ink)]">
      {errorMessage(error)}
    </p>
  );
}

/** A short warning block — the tint is the signal, the words carry the meaning. */
function WarningBlock({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-2xl border border-[var(--border)] bg-[var(--late-soft)] px-4 py-3 text-start text-sm leading-7 text-[var(--ink)]">
      {children}
    </p>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 transition-colors duration-150 hover:border-[var(--border-strong)] has-[:checked]:border-[var(--brand)] has-[:checked]:bg-[var(--brand-soft)]">
      <input
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--brand)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0 text-start">
        <span className="block text-sm font-semibold text-[var(--ink)]">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-[var(--ink-2)]">{hint}</span>
      </span>
    </label>
  );
}

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Moon }[] = [
  { value: "dark", label: "داكن", icon: Moon },
  { value: "light", label: "فاتح", icon: Sun },
];

/**
 * «المظهر». No Save button by design: the choice paints immediately and lives
 * in localStorage on this device, so there is nothing to send anywhere.
 */
function AppearanceSection() {
  const [theme, setTheme] = useTheme();

  return (
    <Card title="المظهر">
      <div className="space-y-3">
        <div
          role="radiogroup"
          aria-label="مظهر التطبيق"
          className="inline-flex gap-1 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-1"
        >
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const active = theme === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTheme(value)}
                className={cn(
                  "flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
                  active
                    ? "bg-[var(--brand)] text-[var(--brand-contrast)]"
                    : "text-[var(--ink-2)] hover:bg-[var(--surface-3)] hover:text-[var(--ink)]",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {label}
              </button>
            );
          })}
        </div>

        <p className="text-start text-xs leading-6 text-[var(--ink-3)]">
          الوضع الداكن هو الافتراضي وأوفر لبطارية الشاشة أثناء الحصة. الاختيار محفوظ على هذا
          الجهاز فقط ولا يؤثر على بقية المستخدمين.
        </p>
      </div>
    </Card>
  );
}

/* ─────────────────────────────── the page ─────────────────────────────── */

export function Settings() {
  const queryClient = useQueryClient();

  const [general, setGeneral] = useState<GeneralForm | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderForm | null>(null);
  const [drafts, setDrafts] = useState<Record<string, TemplateDraft>>({});
  const [password, setPassword] = useState<PasswordForm>(EMPTY_PASSWORD);
  const [passwordError, setPasswordError] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const [generalNotice, setGeneralNotice] = useTransientNotice();
  const [providerNotice, setProviderNotice] = useTransientNotice();
  const [templateNotice, setTemplateNotice] = useTransientNotice();
  const [passwordNotice, setPasswordNotice] = useTransientNotice();

  const settingsLoadedAt = useRef(0);
  const templatesLoadedAt = useRef(0);
  const bodyRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  /**
   * The last payload the server sent for each form, plus live mirrors of the
   * forms themselves. A refetch (window focus, a realtime "setting" event) must
   * refresh a section the user has not touched — and must never overwrite one
   * they are in the middle of editing.
   */
  const lastGeneral = useRef<GeneralForm | null>(null);
  const lastProvider = useRef<ProviderForm | null>(null);
  const lastTemplates = useRef<Record<string, TemplateDraft>>({});
  const generalRef = useRef<GeneralForm | null>(general);
  const providerRef = useRef<ProviderForm | null>(providerForm);
  const draftsRef = useRef<Record<string, TemplateDraft>>(drafts);

  /** Set by a save: the next payload is ours, so take it verbatim (the server
   *  trims and coerces, and its version is the one that counts from now on). */
  const adoptGeneral = useRef(false);
  const adoptProvider = useRef(false);
  const adoptTemplate = useRef<string | null>(null);

  generalRef.current = general;
  providerRef.current = providerForm;
  draftsRef.current = drafts;

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<SettingsData>("/settings"),
  });

  const templates = useQuery({
    queryKey: ["templates"],
    queryFn: () => api.get<MessageTemplate[]>("/templates"),
  });

  // Deliberately not under the ["templates"] prefix: the placeholder contract
  // is code, not data, so no template save should ever refetch it.
  const placeholders = useQuery({
    queryKey: ["template-placeholders"],
    queryFn: () => api.get<Record<string, string[]>>("/templates/placeholders"),
    staleTime: Infinity,
  });

  const templateRows = useMemo(() => templates.data ?? [], [templates.data]);

  /** The server-rendered preview of each *saved* template body. */
  const previews = useQuery({
    queryKey: ["template-previews"],
    enabled: templateRows.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        templateRows.map(async (row) => {
          try {
            const result = await api.post<PreviewResult>("/messages/preview", {
              templateKey: row.key,
            });
            return [row.key, result?.body ?? ""] as const;
          } catch {
            return [row.key, ""] as const;
          }
        }),
      );
      return Object.fromEntries(entries) as Record<string, string>;
    },
  });

  // Each form adopts a new server payload only while it is pristine, which
  // covers both the first load and the refetch that follows its own save.
  useEffect(() => {
    if (!settings.data || settings.dataUpdatedAt === settingsLoadedAt.current) return;
    settingsLoadedAt.current = settings.dataUpdatedAt;

    const incomingGeneral = toGeneralForm(settings.data);
    const incomingProvider = toProviderForm(settings.data);

    const generalPristine =
      !generalRef.current || same(generalRef.current, lastGeneral.current);
    const providerPristine =
      !providerRef.current || same(providerRef.current, lastProvider.current);

    if (adoptGeneral.current || generalPristine) setGeneral(incomingGeneral);
    if (adoptProvider.current || providerPristine) setProviderForm(incomingProvider);

    adoptGeneral.current = false;
    adoptProvider.current = false;
    lastGeneral.current = incomingGeneral;
    lastProvider.current = incomingProvider;
  }, [settings.data, settings.dataUpdatedAt]);

  useEffect(() => {
    if (!templates.data || templates.dataUpdatedAt === templatesLoadedAt.current) return;
    templatesLoadedAt.current = templates.dataUpdatedAt;

    const incoming: Record<string, TemplateDraft> = {};
    for (const row of templates.data) {
      incoming[row.key] = {
        name: row.name || TEMPLATE_NAME_AR[row.key] || row.key,
        body: row.body ?? "",
        isActive: row.isActive !== false,
      };
    }

    // Per template, so saving one never discards an edit in progress on another.
    const current = draftsRef.current;
    const merged: Record<string, TemplateDraft> = {};
    for (const [key, row] of Object.entries(incoming)) {
      const local = current[key];
      const previous = lastTemplates.current[key];
      const edited = local !== undefined && previous !== undefined && !same(local, previous);
      merged[key] = edited && adoptTemplate.current !== key ? local : row;
    }

    adoptTemplate.current = null;
    lastTemplates.current = incoming;
    setDrafts(merged);
  }, [templates.data, templates.dataUpdatedAt]);

  /* ─────────────────────────── mutations ─────────────────────────── */

  const saveGeneral = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<SettingsData>("/settings", body),
    onSuccess: () => {
      adoptGeneral.current = true;
      setGeneralNotice("تم حفظ الإعدادات العامة");
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["template-previews"] });
    },
  });

  const saveProvider = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<SettingsData>("/settings", body),
    onSuccess: () => {
      adoptProvider.current = true;
      setProviderNotice("تم حفظ إعدادات المزوّد");
      setTestResult(null);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
    },
  });

  const testSend = useMutation({
    mutationFn: (phone: string) => api.post<TestResult>("/settings/test", { phone }),
    onSuccess: (result) => setTestResult(result),
    onError: () => setTestResult(null),
  });

  const saveTemplate = useMutation({
    mutationFn: (payload: { key: string; name: string; body: string; isActive: boolean }) =>
      api.put<MessageTemplate>("/templates", payload),
    onSuccess: (_result, payload) => {
      adoptTemplate.current = payload.key;
      setTemplateNotice(`تم حفظ قالب «${payload.name}»`);
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      queryClient.invalidateQueries({ queryKey: ["template-previews"] });
    },
  });

  const changePassword = useMutation({
    mutationFn: (payload: { oldPassword: string; newPassword: string }) =>
      api.post<{ ok?: boolean }>("/auth/change-password", payload),
    onSuccess: () => {
      setPassword(EMPTY_PASSWORD);
      setPasswordError("");
      setPasswordNotice("تم تغيير كلمة المرور");
    },
  });

  /* ───────────────────────── derived state ───────────────────────── */

  const generalBaseline = settings.data ? toGeneralForm(settings.data) : null;
  const providerBaseline = settings.data ? toProviderForm(settings.data) : null;

  const generalDirty = general !== null && !same(general, generalBaseline);
  const providerDirty = providerForm !== null && !same(providerForm, providerBaseline);

  const threshold = Number(general?.lowGradeThreshold ?? 60);
  const thresholdText = Number.isFinite(threshold) ? arNum(threshold) : "٦٠";

  /**
   * Sample values for the live preview — a mirror of `sampleVars()` in
   * server/src/messaging/outbox.ts, so an unsaved draft previews exactly as the
   * server would render it. Teacher name and threshold follow the form above,
   * which makes the effect of a change visible before it is even saved.
   */
  const previewVars = useMemo<Record<string, string>>(() => {
    const today = todayISO();
    return {
      student_name: "أحمد محمود عبد الرحمن",
      parent_name: "محمود عبد الرحمن",
      teacher_name: general?.tutorName?.trim() || "الأستاذ أحمد",
      center_name: general?.centerName?.trim() ?? "",
      subject: "الرياضيات",
      class_name: "مجموعة السبت - ٣ ثانوي",
      date_ar: arDate(today),
      time_ar: arTime("16:00"),
      minutes_late: "15",
      assessment_title: "اختبار الوحدة الأولى",
      score: "42",
      max_score: "100",
      percentage: "42.0",
      threshold: general?.lowGradeThreshold ?? "60",
      period_ar: arMonth(currentMonthISO()),
      sessions_total: "8",
      present_count: "6",
      absent_count: "1",
      late_count: "1",
      attendance_rate: "88",
      assessments_count: "3",
      average_percentage: "72.5",
      best_percentage: "88.0",
      worst_percentage: "55.0",
      teacher_note: "نتمنى له دوام التوفيق والتقدم.",
    };
  }, [general?.tutorName, general?.centerName, general?.lowGradeThreshold]);

  /* ──────────────────────────── actions ──────────────────────────── */

  const persistGeneral = () => {
    if (!general) return;
    saveGeneral.mutate({
      tutorName: general.tutorName.trim(),
      centerName: general.centerName.trim(),
      defaultCountryCode: general.defaultCountryCode.trim() || "+20",
      lowGradeThreshold: general.lowGradeThreshold,
      autoSendAbsence: general.autoSendAbsence,
      autoSendLate: general.autoSendLate,
      autoSendLowGrade: general.autoSendLowGrade,
      quietHoursStart: general.quietHoursStart,
      quietHoursEnd: general.quietHoursEnd,
    });
  };

  const persistProvider = () => {
    if (!providerForm) return;
    saveProvider.mutate({
      provider: providerForm.provider,
      providerConfig: toProviderConfig(providerForm),
    });
  };

  const submitPassword = () => {
    if (!password.current) {
      setPasswordError("أدخل كلمة المرور الحالية.");
      return;
    }
    if (password.next.length < PASSWORD_MIN_LENGTH) {
      setPasswordError(`كلمة المرور الجديدة يجب ألا تقل عن ${arNum(PASSWORD_MIN_LENGTH)} أحرف.`);
      return;
    }
    if (password.next === password.current) {
      setPasswordError("كلمة المرور الجديدة يجب أن تختلف عن الحالية.");
      return;
    }
    if (password.next !== password.confirm) {
      setPasswordError("كلمتا المرور غير متطابقتين.");
      return;
    }
    setPasswordError("");
    changePassword.mutate({ oldPassword: password.current, newPassword: password.next });
  };

  /** Drops a `{{placeholder}}` where the caret is, then puts the caret after it. */
  const insertPlaceholder = (key: string, name: string) => {
    const draft = drafts[key];
    if (!draft) return;

    const node = bodyRefs.current[key];
    const token = `{{${name}}}`;
    const start = node?.selectionStart ?? draft.body.length;
    const end = node?.selectionEnd ?? draft.body.length;

    setDrafts((current) => ({
      ...current,
      [key]: { ...draft, body: `${draft.body.slice(0, start)}${token}${draft.body.slice(end)}` },
    }));

    window.requestAnimationFrame(() => {
      const target = bodyRefs.current[key];
      if (!target) return;
      const caret = start + token.length;
      target.focus();
      target.setSelectionRange(caret, caret);
    });
  };

  /* ──────────────────────────── rendering ────────────────────────── */

  if (settings.isLoading || (!general && !settings.isError)) {
    return (
      <>
        <PageHeader title="الإعدادات" />
        <Card>
          <LoadingBlock />
        </Card>
      </>
    );
  }

  if (settings.isError || !general || !providerForm) {
    return (
      <>
        <PageHeader title="الإعدادات" />
        <div className="space-y-6">
          <ErrorLine error={settings.error} />
          <AppearanceSection />
        </div>
      </>
    );
  }

  const providerHint = PROVIDERS.find((p) => p.value === providerForm.provider)?.hint ?? "";

  return (
    <div>
      <PageHeader
        title="الإعدادات"
        subtitle="بيانات المُدرِّس، مزوّد الإرسال، نصوص الرسائل، كلمة المرور، ومظهر التطبيق"
      />

      <div className="space-y-6">
        {/* ─────────────────── 1 · general ─────────────────── */}
        <Card
          title="الإعدادات العامة"
          actions={
            <SaveAction
              dirty={generalDirty}
              pending={saveGeneral.isPending}
              notice={generalNotice}
              onSave={persistGeneral}
            />
          }
        >
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Input
                label="اسم المُدرِّس"
                value={general.tutorName}
                onChange={(e) => setGeneral({ ...general, tutorName: e.target.value })}
              />
              <Input
                label="اسم السنتر (اختياري)"
                value={general.centerName}
                onChange={(e) => setGeneral({ ...general, centerName: e.target.value })}
              />
              <Input
                label="مفتاح الدولة الافتراضي"
                dir="ltr"
                placeholder="+20"
                value={general.defaultCountryCode}
                onChange={(e) => setGeneral({ ...general, defaultCountryCode: e.target.value })}
              />
              <div>
                <Input
                  label="حد الدرجة المنخفضة"
                  type="number"
                  min={0}
                  max={100}
                  value={general.lowGradeThreshold}
                  onChange={(e) => setGeneral({ ...general, lowGradeThreshold: e.target.value })}
                />
                <p className="mt-1.5 text-start text-xs text-[var(--ink-3)]">
                  أقل من {thresholdText}٪ يُعتبر ضعيفاً
                </p>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <Toggle
                label="تنبيه الغياب تلقائياً"
                hint="إضافة رسالة لولي الأمر فور تسجيل الطالب غائباً"
                checked={general.autoSendAbsence}
                onChange={(value) => setGeneral({ ...general, autoSendAbsence: value })}
              />
              <Toggle
                label="تنبيه التأخير تلقائياً"
                hint="إضافة رسالة عند تسجيل الطالب متأخراً"
                checked={general.autoSendLate}
                onChange={(value) => setGeneral({ ...general, autoSendLate: value })}
              />
              <Toggle
                label="تنبيه الدرجات المنخفضة"
                hint={`إضافة رسالة عند نزول الدرجة تحت ${thresholdText}٪`}
                checked={general.autoSendLowGrade}
                onChange={(value) => setGeneral({ ...general, autoSendLowGrade: value })}
              />
            </div>

            <div>
              <div className="grid gap-4 sm:grid-cols-2 lg:w-1/2">
                <Input
                  label="بداية ساعات الهدوء"
                  type="time"
                  value={general.quietHoursStart}
                  onChange={(e) => setGeneral({ ...general, quietHoursStart: e.target.value })}
                />
                <Input
                  label="نهاية ساعات الهدوء"
                  type="time"
                  value={general.quietHoursEnd}
                  onChange={(e) => setGeneral({ ...general, quietHoursEnd: e.target.value })}
                />
              </div>
              <p className="mt-2.5 text-start text-xs leading-6 text-[var(--ink-3)]">
                بين {arTime(general.quietHoursStart)} و{arTime(general.quietHoursEnd)} لا تُرسَل أي
                رسالة تلقائياً — تبقى في قائمة الإرسال حتى ينتهي وقت الهدوء. الإرسال اليدوي من
                قائمة الإرسال يعمل في أي وقت.
              </p>
            </div>

            {saveGeneral.isError ? <ErrorLine error={saveGeneral.error} /> : null}
          </div>
        </Card>

        {/* ─────────────────── 2 · provider ─────────────────── */}
        <Card
          title="مزوّد الإرسال"
          actions={
            <SaveAction
              dirty={providerDirty}
              pending={saveProvider.isPending}
              notice={providerNotice}
              onSave={persistProvider}
            />
          }
        >
          <div className="space-y-5">
            <div className="grid gap-4 lg:grid-cols-3">
              <Select
                label="المزوّد"
                value={providerForm.provider}
                onChange={(e) =>
                  setProviderForm({
                    ...providerForm,
                    provider: e.target.value as ProviderName,
                  })
                }
              >
                {PROVIDERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <p className="self-end pb-2.5 text-start text-xs leading-6 text-[var(--ink-2)] lg:col-span-2">
                {providerHint}
              </p>
            </div>

            {providerForm.provider === "GREEN_API" ? (
              <>
                <WarningBlock>
                  <span className="font-bold">تنبيه مهم: </span>
                  Green API بوّابة غير رسمية لواتساب. الرسائل تُرسَل من رقمك عبر جهاز مرتبط، وهذا
                  يخالف شروط استخدام واتساب، وهناك خطر حقيقي بحظر الرقم — خاصة عند إرسال عدد كبير
                  من الرسائل المتشابهة دفعة واحدة. لا تربط رقمك الشخصي الأساسي. الخيار الافتراضي
                  «روابط واتساب» بلا أي مخاطرة لأنك أنت من يضغط إرسال داخل التطبيق.
                </WarningBlock>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Input
                    label="idInstance"
                    dir="ltr"
                    autoComplete="off"
                    value={providerForm.config.idInstance}
                    onChange={(e) =>
                      setProviderForm({
                        ...providerForm,
                        config: { ...providerForm.config, idInstance: e.target.value },
                      })
                    }
                  />
                  <Input
                    label="apiTokenInstance"
                    dir="ltr"
                    type="password"
                    autoComplete="new-password"
                    value={providerForm.config.apiTokenInstance}
                    onChange={(e) =>
                      setProviderForm({
                        ...providerForm,
                        config: { ...providerForm.config, apiTokenInstance: e.target.value },
                      })
                    }
                  />
                  <Input
                    label="apiUrl (اختياري)"
                    dir="ltr"
                    placeholder="https://api.green-api.com"
                    value={providerForm.config.apiUrl}
                    onChange={(e) =>
                      setProviderForm({
                        ...providerForm,
                        config: { ...providerForm.config, apiUrl: e.target.value },
                      })
                    }
                  />
                </div>
              </>
            ) : null}

            {providerForm.provider === "TWILIO" ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Input
                  label="accountSid"
                  dir="ltr"
                  autoComplete="off"
                  value={providerForm.config.accountSid}
                  onChange={(e) =>
                    setProviderForm({
                      ...providerForm,
                      config: { ...providerForm.config, accountSid: e.target.value },
                    })
                  }
                />
                <Input
                  label="authToken"
                  dir="ltr"
                  type="password"
                  autoComplete="new-password"
                  value={providerForm.config.authToken}
                  onChange={(e) =>
                    setProviderForm({
                      ...providerForm,
                      config: { ...providerForm.config, authToken: e.target.value },
                    })
                  }
                />
                <Input
                  label="الرقم المُرسِل"
                  dir="ltr"
                  placeholder="+14155238886"
                  value={providerForm.config.from}
                  onChange={(e) =>
                    setProviderForm({
                      ...providerForm,
                      config: { ...providerForm.config, from: e.target.value },
                    })
                  }
                />
                <Select
                  label="القناة"
                  value={providerForm.config.channel}
                  onChange={(e) =>
                    setProviderForm({
                      ...providerForm,
                      config: { ...providerForm.config, channel: e.target.value },
                    })
                  }
                >
                  <option value="WHATSAPP">واتساب</option>
                  <option value="SMS">رسالة نصية SMS</option>
                </Select>
              </div>
            ) : null}

            {saveProvider.isError ? <ErrorLine error={saveProvider.error} /> : null}

            <div className="border-t border-[var(--border)] pt-5">
              <div className="flex flex-wrap items-start gap-3">
                <div className="w-56">
                  <Input
                    label="اختبار الإرسال — رقم الهاتف"
                    dir="ltr"
                    placeholder="01001234567"
                    value={testPhone}
                    onChange={(e) => setTestPhone(e.target.value)}
                  />
                </div>
                <Button
                  variant="secondary"
                  className="mt-7"
                  disabled={!testPhone.trim() || testSend.isPending}
                  onClick={() => {
                    setTestResult(null);
                    testSend.mutate(testPhone.trim());
                  }}
                >
                  {testSend.isPending ? "جارٍ الاختبار…" : "اختبار الإرسال"}
                </Button>
              </div>

              <p className="mt-2.5 text-start text-xs text-[var(--ink-3)]">
                احفظ إعدادات المزوّد أولاً حتى يستخدم الاختبار البيانات الجديدة.
              </p>

              {testSend.isError ? (
                <div className="mt-3">
                  <ErrorLine error={testSend.error} />
                </div>
              ) : null}

              {testResult ? (
                <div
                  className={cn(
                    "mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border)] px-4 py-3 text-start text-sm leading-7 text-[var(--ink)]",
                    testResult.ok ? "bg-[var(--present-soft)]" : "bg-[var(--absent-soft)]",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    {testResult.message}
                    {testResult.error ? ` (${testResult.error})` : ""}
                  </span>
                  {testResult.waLink ? (
                    /* Through openWhatsapp, not window.open: this is the first
                       «فتح واتساب» a teacher ever presses, and in the APK a
                       wa.me URL is loaded by the WebView itself and never
                       reaches WhatsApp. See lib/openExternal.ts. */
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void openWhatsapp({
                          appLink: testResult.waAppLink ?? "",
                          webLink: testResult.waLink ?? "",
                        })
                      }
                    >
                      فتح واتساب
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </Card>

        {/* ─────────────────── 3 · templates ─────────────────── */}
        <Card
          title="قوالب الرسائل"
          actions={
            templateNotice ? (
              <span className="text-xs font-semibold text-[var(--present-ink)] sm:text-sm">
                {templateNotice}
              </span>
            ) : undefined
          }
        >
          {templates.isLoading ? (
            <LoadingBlock />
          ) : templates.isError ? (
            <ErrorLine error={templates.error} />
          ) : templateRows.length === 0 ? (
            <p className="py-2 text-start text-sm text-[var(--ink-2)]">
              لا توجد قوالب — شغّل تهيئة قاعدة البيانات (prisma/seed).
            </p>
          ) : (
            <div className="space-y-5">
              {templateRows.map((row) => {
                const draft = drafts[row.key];
                if (!draft) return null;

                const dirty =
                  draft.body !== (row.body ?? "") ||
                  draft.name !== (row.name || TEMPLATE_NAME_AR[row.key] || row.key) ||
                  draft.isActive !== (row.isActive !== false);
                const saving = saveTemplate.isPending && saveTemplate.variables?.key === row.key;
                const keys = placeholders.data?.[row.key] ?? [];
                const serverPreview = previews.data?.[row.key] ?? "";
                const preview =
                  dirty || !serverPreview
                    ? renderTemplate(draft.body, previewVars)
                    : serverPreview;

                return (
                  <section
                    key={row.key}
                    className="rounded-[20px] border border-[var(--border)] p-5"
                  >
                    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <h3 className="text-start text-base font-semibold text-[var(--ink)]">
                        {draft.name}
                      </h3>
                      <Badge tone="gray">
                        <span dir="ltr">{row.key}</span>
                      </Badge>
                      <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--ink-2)]">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--brand)]"
                          checked={draft.isActive}
                          onChange={(e) =>
                            setDrafts((current) => ({
                              ...current,
                              [row.key]: { ...draft, isActive: e.target.checked },
                            }))
                          }
                        />
                        مفعّل
                      </label>
                      <span className="ms-auto flex items-center gap-2">
                        <SaveAction
                          dirty={dirty && draft.body.trim() !== ""}
                          pending={saving}
                          notice=""
                          onSave={() =>
                            saveTemplate.mutate({
                              key: row.key,
                              name: draft.name || TEMPLATE_NAME_AR[row.key] || row.key,
                              body: draft.body,
                              isActive: draft.isActive,
                            })
                          }
                        />
                      </span>
                    </div>

                    <div className="grid gap-5 lg:grid-cols-2">
                      <div>
                        <Textarea
                          label="نص القالب"
                          rows={12}
                          ref={(node) => {
                            bodyRefs.current[row.key] = node;
                          }}
                          value={draft.body}
                          onChange={(e) =>
                            setDrafts((current) => ({
                              ...current,
                              [row.key]: { ...draft, body: e.target.value },
                            }))
                          }
                        />
                        {keys.length > 0 ? (
                          <>
                            <p className="mt-3 text-start text-xs text-[var(--ink-3)]">
                              اضغط أي عنصر لإدراجه في مكان المؤشر داخل النص:
                            </p>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {keys.map((name) => (
                                <button
                                  key={name}
                                  type="button"
                                  dir="ltr"
                                  onClick={() => insertPlaceholder(row.key, name)}
                                  className={cn(
                                    "rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 font-mono text-xs text-[var(--ink-2)] transition-colors duration-150",
                                    "hover:border-[var(--brand)] hover:bg-[var(--brand-soft)] hover:text-[var(--brand-ink)]",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
                                  )}
                                >
                                  {`{{${name}}}`}
                                </button>
                              ))}
                            </div>
                          </>
                        ) : null}
                      </div>

                      <div>
                        <p className="mb-1.5 flex flex-wrap items-center gap-2 text-start text-xs font-semibold text-[var(--ink-3)]">
                          المعاينة
                          {dirty ? (
                            <Badge tone="amber">نص غير محفوظ</Badge>
                          ) : (
                            <Badge tone="gray">النسخة المحفوظة</Badge>
                          )}
                        </p>
                        <div className="min-h-40 whitespace-pre-wrap rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 text-start text-sm leading-7 text-[var(--ink)]">
                          {preview || "اكتب نص القالب لتظهر المعاينة."}
                        </div>
                        <p className="mt-2 text-start text-xs leading-6 text-[var(--ink-3)]">
                          المعاينة ببيانات طالب افتراضية — تُملأ عند الإرسال ببيانات الطالب
                          الحقيقي.
                        </p>
                        {saveTemplate.isError && saveTemplate.variables?.key === row.key ? (
                          <div className="mt-2">
                            <ErrorLine error={saveTemplate.error} />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </Card>

        {/* ─────────────────── 4 · account ─────────────────── */}
        <Card
          title="الحساب"
          actions={
            passwordNotice ? (
              <span className="text-xs font-semibold text-[var(--present-ink)] sm:text-sm">
                {passwordNotice}
              </span>
            ) : undefined
          }
        >
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                label="كلمة المرور الحالية"
                type="password"
                autoComplete="current-password"
                value={password.current}
                onChange={(e) => setPassword({ ...password, current: e.target.value })}
              />
              <Input
                label="كلمة المرور الجديدة"
                type="password"
                autoComplete="new-password"
                value={password.next}
                onChange={(e) => setPassword({ ...password, next: e.target.value })}
              />
              <Input
                label="تأكيد كلمة المرور الجديدة"
                type="password"
                autoComplete="new-password"
                value={password.confirm}
                onChange={(e) => setPassword({ ...password, confirm: e.target.value })}
              />
            </div>

            <p className="text-start text-xs leading-6 text-[var(--ink-3)]">
              كلمة المرور الجديدة لا تقل عن {arNum(PASSWORD_MIN_LENGTH)} أحرف ويجب أن تختلف عن
              الحالية. بعد التغيير قد تحتاج إلى تسجيل الدخول من جديد على الأجهزة الأخرى.
            </p>

            {passwordError ? (
              <p className="rounded-2xl border border-[var(--border)] bg-[var(--absent-soft)] px-4 py-3 text-start text-sm font-semibold leading-7 text-[var(--ink)]">
                {passwordError}
              </p>
            ) : null}
            {changePassword.isError ? <ErrorLine error={changePassword.error} /> : null}

            <div className="flex justify-start">
              <Button
                onClick={submitPassword}
                disabled={
                  changePassword.isPending ||
                  (!password.current && !password.next && !password.confirm)
                }
              >
                {changePassword.isPending ? "جارٍ التغيير…" : "تغيير كلمة المرور"}
              </Button>
            </div>
          </div>
        </Card>

        {/* ─────────────────── 5 · appearance ─────────────────── */}
        <AppearanceSection />
      </div>
    </div>
  );
}

export default Settings;
