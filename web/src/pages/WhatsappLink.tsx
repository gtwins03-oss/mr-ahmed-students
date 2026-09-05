/**
 * /whatsapp — logging the teacher's own WhatsApp number into the app.
 *
 * This is the one screen that turns the system from "the app writes the message
 * and you press send" into "the app sends it". It has exactly three faces, and
 * which one is showing is decided by `Setting.whatsappState` on the server:
 *
 *   SETUP  — nothing configured yet: what this does, what it costs, what it
 *            risks, and the two Green API credentials.
 *   SCAN   — configured but not linked: a QR polled every three seconds, on a
 *            *white* panel — a QR on a tinted card does not scan reliably.
 *   LINKED — AUTHORIZED: the number, the date, and how to undo it.
 *
 * BLOCKED and ERROR each get their own screen, because "واتساب حظر الرقم" and
 * "التوكن غلط" need completely different actions from the teacher.
 *
 * The QR poll is deliberately *not* a react-query query. The query cache is
 * mirrored into localStorage (see main.tsx), and a base64 PNG that expires
 * after a few seconds is the last thing that should be persisted and restored:
 * the teacher would come back to a dead code and scan it forever. It lives in
 * component state, and `useQrPoll` clears both the interval and the in-flight
 * response on unmount.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, QrCode, ShieldAlert, Smartphone } from "lucide-react";

import { api, errorMessage } from "../api/client";
import type {
  Settings,
  WhatsappLinkRequest,
  WhatsappQr,
  WhatsappState,
  WhatsappStatus,
} from "../api/types";
import {
  Button,
  Card,
  ConfirmButton,
  Input,
  LoadingBlock,
  PageHeader,
  Spinner,
} from "../components/ui";
import { arDateTime, arNum } from "../lib/format";
import { openExternal } from "../lib/openExternal";

/** The gateway rotates the code every ~20s; three seconds keeps it fresh. */
const QR_POLL_MS = 3_000;

const GREEN_API_URL = "https://green-api.com";

/** Approximate monthly cost of the paid Green API tier, in US dollars. */
const PAID_PLAN_USD = 14;

/* ──────────────────────────── payload reading ─────────────────────────── */

const STATES: readonly WhatsappState[] = [
  "UNKNOWN",
  "NOT_AUTHORIZED",
  "QR_PENDING",
  "AUTHORIZED",
  "BLOCKED",
  "ERROR",
];

/** Narrows a state off the wire, so an unknown string never reaches the UI. */
function readState(value: unknown): WhatsappState | null {
  return typeof value === "string" && (STATES as readonly string[]).includes(value)
    ? (value as WhatsappState)
    : null;
}

/** Anything that is not a non-empty string becomes "" — never "undefined". */
function readText(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

/**
 * The PNG out of a `kind: "qr"` payload, as a ready `src`.
 *
 * The server hands over a finished `data:image/png;base64,…` (it builds it in
 * messaging/whatsapp-link.ts, because Green API answers with bare base64). The
 * `data:image` test is the guard that matters: it is what keeps an Arabic error
 * sentence from ever being handed to <img>.
 */
function toDataUri(payload: WhatsappQr | undefined): string {
  if (payload?.kind !== "qr") return "";
  const value = readText(payload.pngDataUri);
  return value.startsWith("data:image") ? value : "";
}

/** "+201001234567" → "+20 100 123 4567"; unknown shapes pass through as-is. */
function prettyPhone(e164: string, countryCode: string): string {
  const raw = readText(e164);
  if (!raw) return "";

  const digits = raw.replace(/\D/g, "");
  const code = countryCode.replace(/\D/g, "");
  const hasCode = code !== "" && digits.startsWith(code) && digits.length > code.length;
  const local = hasCode ? digits.slice(code.length) : digits;

  const groups =
    local.length > 6 ? [local.slice(0, 3), local.slice(3, 6), local.slice(6)] : [local];
  const prefix = hasCode ? `+${code} ` : raw.startsWith("+") ? "+" : "";
  return `${prefix}${groups.join(" ")}`;
}

/* ─────────────────────────────── the QR poll ──────────────────────────── */

type QrPoll = {
  /** "data:image/png;base64,…" — "" while the gateway has not produced one. */
  image: string;
  /** The state the gateway reported alongside the code. */
  state: WhatsappState | null;
  /** Arabic message from the last failed tick; the image is kept meanwhile. */
  error: string;
};

const IDLE_POLL: QrPoll = { image: "", state: null, error: "" };

/**
 * Polls `GET /api/whatsapp/qr` while `enabled`, and stops dead otherwise.
 *
 * `alive` matters as much as `clearInterval`: a request that was already in
 * flight when the teacher navigated away must not land, because its result
 * would be a QR that no longer exists.
 *
 * The endpoint answers 200 with a `kind` rather than an HTTP error, so the
 * three cases are handled here rather than split between `then` and `catch`:
 *
 *   "qr"             — a fresh code; swap the image in.
 *   "already-linked" — the phone scanned it. AUTHORIZED here is what flips the
 *                      screen to LINKED before the 60-second status query is
 *                      due, so the teacher sees it land immediately.
 *   "error"          — a bad tick. The state is deliberately left alone and the
 *                      previous image kept: one dropped packet on a weak
 *                      connection must not blank a code being scanned, nor throw
 *                      the whole page onto the «تعذّر الاتصال» screen.
 */
function useQrPoll(enabled: boolean): QrPoll {
  const [poll, setPoll] = useState<QrPoll>(IDLE_POLL);

  useEffect(() => {
    if (!enabled) {
      setPoll(IDLE_POLL);
      return;
    }

    let alive = true;

    const tick = async () => {
      try {
        const data = await api.get<WhatsappQr>("/whatsapp/qr");
        if (!alive) return;

        if (data?.kind === "qr") {
          setPoll({ image: toDataUri(data), state: "QR_PENDING", error: "" });
        } else if (data?.kind === "already-linked") {
          setPoll({ image: "", state: "AUTHORIZED", error: "" });
        } else {
          const error = readText(data?.error) || "تعذّر تحديث رمز الربط";
          setPoll((current) => ({ ...current, error }));
        }
      } catch (err) {
        if (!alive) return;
        setPoll((current) => ({ ...current, error: errorMessage(err) }));
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), QR_POLL_MS);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return poll;
}

/* ────────────────────────────── small parts ───────────────────────────── */

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="list-inside space-y-2 text-start text-sm leading-7 text-slate-600 [list-style-type:arabic-indic]">
      {items.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-start text-sm font-medium text-rose-700">
      {children}
    </p>
  );
}

/** The always-available escape hatch, mentioned on every failure screen. */
function ManualFallbackNote() {
  return (
    <p className="text-start text-sm leading-7 text-slate-600">
      البديل بلا أي مخاطرة هو البقاء على «روابط واتساب»: التطبيق يجهّز نص كل رسالة وتضغط أنت
      «إرسال» داخل واتساب من{" "}
      <Link to="/messages" className="font-semibold text-blue-700 underline underline-offset-4">
        قائمة الإرسال
      </Link>
      . يمكنك تغيير المزوّد في أي وقت من{" "}
      <Link to="/settings" className="font-semibold text-blue-700 underline underline-offset-4">
        الإعدادات
      </Link>
      .
    </p>
  );
}

/* ─────────────────────────────── the page ─────────────────────────────── */

type LinkForm = { idInstance: string; apiTokenInstance: string };

export function WhatsappLink() {
  const queryClient = useQueryClient();

  const [form, setForm] = useState<LinkForm>({ idInstance: "", apiTokenInstance: "" });
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const prefilled = useRef(false);

  const status = useQuery({
    queryKey: ["whatsapp", "status"],
    queryFn: () => api.get<WhatsappStatus>("/whatsapp/status"),
    refetchInterval: 60_000,
  });

  // The persisted settings row is the fallback for everything the live status
  // payload may leave out: the number, the link date, the active provider.
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/settings"),
  });

  const live = status.data;
  const row = settings.data;
  const config = row?.providerConfig ?? {};

  const configured =
    live?.configured ?? Boolean(readText(config.idInstance) && readText(config.apiTokenInstance));

  const serverState = readState(live?.state) ?? readState(row?.whatsappState) ?? "UNKNOWN";

  // Nothing to scan once the account is authorised, blocked, or faulted — and
  // nothing to scan while the credentials form is open.
  const waitingForScan =
    configured &&
    !editing &&
    (serverState === "QR_PENDING" ||
      serverState === "NOT_AUTHORIZED" ||
      serverState === "UNKNOWN");

  const poll = useQrPoll(waitingForScan);

  // The poll reaches the gateway every three seconds, so it sees the scan land
  // before the status endpoint is asked again — take its word and refresh the
  // rest of the screen (number, date) from the server.
  const state = poll.state ?? serverState;

  useEffect(() => {
    if (!poll.state || poll.state === serverState) return;
    queryClient.invalidateQueries({ queryKey: ["whatsapp", "status"] });
    queryClient.invalidateQueries({ queryKey: ["settings"] });
  }, [poll.state, serverState, queryClient]);

  // The instance id is not a secret and is tedious to retype; the token is
  // write-only and is never sent back to the browser, so it stays blank.
  useEffect(() => {
    const saved = readText(config.idInstance);
    if (prefilled.current || !saved) return;
    prefilled.current = true;
    setForm((current) => (current.idInstance ? current : { ...current, idInstance: saved }));
  }, [config.idInstance]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["whatsapp"] });
    queryClient.invalidateQueries({ queryKey: ["settings"] });
    queryClient.invalidateQueries({ queryKey: ["messages"] });
  };

  const link = useMutation({
    mutationFn: (body: WhatsappLinkRequest) => api.post<WhatsappStatus>("/whatsapp/link", body),
    onSuccess: () => {
      setEditing(false);
      setForm((current) => ({ ...current, apiTokenInstance: "" }));
      setNotice("تم حفظ البيانات. امسح رمز الربط من تليفونك لإتمام العملية.");
      invalidate();
    },
    onError: (error) => setNotice(errorMessage(error)),
  });

  const refresh = useMutation({
    mutationFn: () => api.post<WhatsappStatus>("/whatsapp/refresh"),
    onSuccess: (result) => {
      const fresh = readState(result?.state);
      setNotice(
        fresh === "AUTHORIZED"
          ? "الحساب مرتبط ويعمل."
          : readText(result?.warning) || readText(result?.stateLabel) || "تم تحديث الحالة.",
      );
      invalidate();
    },
    onError: (error) => setNotice(errorMessage(error)),
  });

  const unlink = useMutation({
    mutationFn: () => api.post<WhatsappStatus>("/whatsapp/unlink"),
    onSuccess: () => {
      setNotice("تم فصل الحساب. عادت الرسائل إلى الإرسال اليدوي من قائمة الإرسال.");
      invalidate();
    },
    onError: (error) => setNotice(errorMessage(error)),
  });

  const busy = link.isPending || refresh.isPending || unlink.isPending;

  const phone = prettyPhone(
    readText(live?.phone) || readText(row?.tutorWhatsapp),
    readText(row?.defaultCountryCode) || "+20",
  );
  const linkedAt = readText(live?.linkedAt) || readText(row?.whatsappLinkedAt);
  // One field, not two: the server sends a single Arabic `warning` from its last
  // live probe, and it is the same sentence whether the screen is LINKED (a
  // footnote) or BLOCKED / FAULT (the headline reason).
  const serverWarning = readText(live?.warning);
  const provider = row?.provider ?? "WA_LINK";

  const canSubmit =
    form.idInstance.trim() !== "" && form.apiTokenInstance.trim() !== "" && !link.isPending;

  const submit = () => {
    if (!canSubmit) return;
    link.mutate({
      idInstance: form.idInstance.trim(),
      apiTokenInstance: form.apiTokenInstance.trim(),
    });
  };

  /* ──────────────────────────── rendering ───────────────────────────── */

  if (status.isLoading && !row) {
    return (
      <>
        <PageHeader title="ربط واتساب" />
        <LoadingBlock />
      </>
    );
  }

  if (status.isError && !row) {
    return (
      <>
        <PageHeader title="ربط واتساب" />
        <Card>
          <div className="space-y-3">
            <ErrorLine>{errorMessage(status.error)}</ErrorLine>
            <Button
              variant="secondary"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["whatsapp"] })}
            >
              إعادة المحاولة
            </Button>
          </div>
        </Card>
      </>
    );
  }

  const screen =
    !configured || editing
      ? "SETUP"
      : state === "AUTHORIZED"
        ? "LINKED"
        : state === "BLOCKED"
          ? "BLOCKED"
          : state === "ERROR"
            ? "FAULT"
            : "SCAN";

  const refreshButton = (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={() => refresh.mutate()}
    >
      {refresh.isPending ? "جارٍ التحديث…" : "تحديث الحالة"}
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="ربط واتساب"
        subtitle="اربط رقم واتساب حضرتك مرة واحدة، فيرسل التطبيق تنبيهات الغياب والدرجات لأولياء الأمور بنفسه"
      />

      <div className="space-y-5">
        {notice ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-800">
            <span className="text-start">{notice}</span>
            <button
              type="button"
              className="shrink-0 text-xs underline underline-offset-4"
              onClick={() => setNotice("")}
            >
              إخفاء
            </button>
          </div>
        ) : null}

        {/* ─────────────────── A · not configured yet ─────────────────── */}
        {screen === "SETUP" ? (
          <>
            <Card title="ما الذي يفعله الربط؟">
              <div className="space-y-3">
                <p className="text-start text-sm leading-7 text-slate-700">
                  الآن التطبيق يجهّز نص الرسالة وتفتح أنت واتساب وتضغط «إرسال» لكل ولي أمر. بعد
                  الربط يرسل التطبيق الرسائل بنفسه — من رقمك أنت وبنفس النص — دون أن تفتح واتساب،
                  فتصل تنبيهات الغياب والدرجات لحظة تسجيلها.
                </p>
                <p className="text-start text-sm leading-7 text-slate-700">
                  <span className="font-bold">التكلفة: </span>
                  الربط يتم عبر خدمة Green API. فيها خطة مجانية تكفي للتجربة لكنها محدودة العدد
                  وقد تضيف تأخيراً بسيطاً، وخطة مدفوعة بحوالي {arNum(PAID_PLAN_USD)} دولاراً في
                  الشهر. الاشتراك يخصّك أنت مباشرة مع الخدمة، وليس جزءاً من التطبيق.
                </p>
              </div>
            </Card>

            <Card
              title={
                <span className="flex items-center gap-2">
                  <ShieldAlert className="h-5 w-5 text-amber-600" />
                  اقرأ هذا قبل الربط
                </span>
              }
            >
              <div className="space-y-3">
                <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-start text-sm leading-7 text-amber-900">
                  <span className="font-bold">Green API بوّابة غير رسمية لواتساب. </span>
                  هي تتصرّف كأنها جهاز مرتبط برقمك، وهذا يخالف شروط استخدام واتساب. النتيجة
                  الواقعية: هناك احتمال حقيقي بحظر الرقم — مؤقتاً أو نهائياً — خصوصاً مع الإرسال
                  بكثافة أو رسائل متشابهة دفعة واحدة أو لو بلّغ عنها ولي أمر كإزعاج. لا تربط رقمك
                  الشخصي الأساسي؛ استخدم رقماً مخصصاً للسنتر.
                </p>
                <ManualFallbackNote />
              </div>
            </Card>

            <Card
              title="كيف تحصل على بيانات الربط؟"
              actions={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void openExternal(GREEN_API_URL)}
                >
                  <ExternalLink className="h-4 w-4" />
                  فتح green-api.com
                </Button>
              }
            >
              <div className="space-y-4">
                <Steps
                  items={[
                    "افتح موقع green-api.com وأنشئ حساباً مجانياً ببريدك الإلكتروني.",
                    "من لوحة التحكم اضغط «Create instance» واختر الخطة المناسبة (المجانية تكفي للتجربة).",
                    "افتح الـ instance بعد إنشائها — ستجد بجوارها قيمتين: idInstance و apiTokenInstance.",
                    "انسخ القيمتين والصقهما في الخانتين بالأسفل ثم اضغط «حفظ وربط».",
                    "سيظهر لك رمز QR في هذه الصفحة — امسحه من واتساب على تليفونك لإتمام الربط.",
                  ]}
                />

                <div className="grid gap-4 sm:grid-cols-2">
                  <Input
                    label="idInstance"
                    dir="ltr"
                    autoComplete="off"
                    placeholder="1101234567"
                    value={form.idInstance}
                    onChange={(e) => setForm({ ...form, idInstance: e.target.value })}
                  />
                  <Input
                    label="apiTokenInstance"
                    dir="ltr"
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••••••••••"
                    value={form.apiTokenInstance}
                    onChange={(e) => setForm({ ...form, apiTokenInstance: e.target.value })}
                  />
                </div>

                {link.isError ? <ErrorLine>{errorMessage(link.error)}</ErrorLine> : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={!canSubmit} onClick={submit}>
                    {link.isPending ? "جارٍ الحفظ…" : "حفظ وربط"}
                  </Button>
                  {editing ? (
                    <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                      إلغاء
                    </Button>
                  ) : null}
                  <span className="text-xs text-slate-500">
                    تُحفظ البيانات على الخادم ولا تظهر مرة أخرى في المتصفح.
                  </span>
                </div>
              </div>
            </Card>
          </>
        ) : null}

        {/* ─────────────────── B · configured, awaiting scan ─────────── */}
        {screen === "SCAN" ? (
          <Card
            title={
              <span className="flex items-center gap-2">
                <QrCode className="h-5 w-5 text-blue-600" />
                امسح رمز الربط من تليفونك
              </span>
            }
            actions={refreshButton}
          >
            {/* `_` not `,` — Tailwind v4 emits an arbitrary value verbatim, and
                `auto,1fr` is invalid CSS the browser silently drops. */}
            <div className="grid gap-6 lg:grid-cols-[auto_1fr] lg:items-start">
              {/* White panel on purpose: a QR on a tinted card does not scan. */}
              <div
                aria-live="polite"
                className="mx-auto flex items-center justify-center rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                {poll.image ? (
                  <img
                    src={poll.image}
                    alt="رمز ربط واتساب"
                    width={240}
                    height={240}
                    className="h-60 w-60 max-w-full bg-white object-contain [image-rendering:pixelated] sm:h-64 sm:w-64"
                  />
                ) : (
                  <div className="flex h-60 w-60 flex-col items-center justify-center gap-3 bg-white text-center text-sm text-slate-500 sm:h-64 sm:w-64">
                    <Spinner />
                    <span>جارٍ تجهيز الرمز…</span>
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-2 text-start text-sm font-bold text-slate-800">
                  <Smartphone className="h-5 w-5 shrink-0 text-slate-400" />
                  على تليفونك، بالترتيب:
                </div>
                <Steps
                  items={[
                    "افتح واتساب على تليفونك.",
                    "اضغط «الإعدادات» (في أندرويد: النقاط الثلاث أعلى الشاشة).",
                    "اختر «الأجهزة المرتبطة».",
                    "اضغط «ربط جهاز».",
                    "وجّه الكاميرا إلى الرمز الظاهر في هذه الصفحة.",
                  ]}
                />
                <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-start text-sm leading-7 text-slate-600">
                  الرمز يتجدّد تلقائياً كل بضع ثوانٍ، فلو انتهت صلاحيته انتظر لحظة وسيظهر رمز
                  جديد. اترك هذه الصفحة مفتوحة حتى تتحوّل إلى رسالة «تم الربط».
                </p>

                {poll.error ? (
                  <p className="text-start text-xs font-medium text-amber-700">
                    تعذّر تحديث الرمز الآن ({poll.error}) — ما زلنا نحاول.
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
                    تعديل بيانات الربط
                  </Button>
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    confirmLabel="تأكيد المسح؟"
                    disabled={busy}
                    onConfirm={() => unlink.mutate()}
                  >
                    مسح البيانات
                  </ConfirmButton>
                </div>
              </div>
            </div>
          </Card>
        ) : null}

        {/* ─────────────────── C · linked ─────────────────────────────── */}
        {screen === "LINKED" ? (
          <>
            {/* Not a <Card>: overriding its own border/background colour from
                the outside would leave two conflicting Tailwind utilities on
                one element, and which wins depends on CSS emission order. */}
            <section className="overflow-hidden rounded-xl border border-emerald-300 bg-emerald-50 p-4 shadow-sm">
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-8 w-8 shrink-0 text-emerald-600" />
                  <div className="min-w-0 space-y-1">
                    <h2 className="text-start text-lg font-bold text-emerald-900 sm:text-xl">
                      تم ربط واتساب بنجاح
                    </h2>
                    <p className="text-start text-base font-bold text-emerald-800">
                      متصل:{" "}
                      {phone ? (
                        <span dir="ltr" className="font-mono">
                          {phone}
                        </span>
                      ) : (
                        <span className="font-normal">
                          الرقم غير متاح بعد — اضغط «تحديث الحالة»
                        </span>
                      )}
                    </p>
                    <p className="text-start text-sm text-emerald-800">
                      تاريخ الربط: {linkedAt ? arDateTime(linkedAt) : "—"}
                    </p>
                  </div>
                </div>

                <p className="rounded-xl border border-emerald-200 bg-white px-4 py-3 text-start text-sm leading-7 text-emerald-900">
                  تنبيهات الغياب والدرجات المنخفضة تُرسَل الآن تلقائياً من هذا الرقم إلى أولياء
                  الأمور، دون الحاجة لفتح واتساب. تبقى كل رسالة مسجّلة في{" "}
                  <Link
                    to="/messages"
                    className="font-semibold underline underline-offset-4"
                  >
                    قائمة الإرسال
                  </Link>{" "}
                  حتى تعرف ما وصل ومتى، ولا يُرسَل أي شيء أثناء ساعات الهدوء.
                </p>

                {provider !== "GREEN_API" ? (
                  <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-start text-sm leading-7 text-amber-900">
                    الحساب مرتبط، لكن المزوّد النشط في{" "}
                    <Link to="/settings" className="font-semibold underline underline-offset-4">
                      الإعدادات
                    </Link>{" "}
                    ما زال «روابط واتساب»، فالرسائل تنتظر ضغطك اليدوي. اختر «Green API» من مزوّد
                    الإرسال ليبدأ الإرسال التلقائي.
                  </p>
                ) : null}

                {serverWarning ? (
                  <p className="text-start text-sm text-emerald-800">{serverWarning}</p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  {refreshButton}
                  <ConfirmButton
                    confirmLabel="تأكيد فصل الحساب؟"
                    disabled={busy}
                    onConfirm={() => unlink.mutate()}
                  >
                    {unlink.isPending ? "جارٍ الفصل…" : "فصل الحساب"}
                  </ConfirmButton>
                </div>

                <p className="text-start text-xs leading-6 text-emerald-800">
                  فصل الحساب يوقف الإرسال التلقائي فوراً ويعيدك إلى الإرسال اليدوي. لن تفقد أي
                  رسالة — تبقى في قائمة الإرسال حتى ترسلها بنفسك.
                </p>
              </div>
            </section>

            {unlink.isError ? <ErrorLine>{errorMessage(unlink.error)}</ErrorLine> : null}
          </>
        ) : null}

        {/* ─────────────────── BLOCKED ────────────────────────────────── */}
        {screen === "BLOCKED" ? (
          <section className="overflow-hidden rounded-xl border border-rose-300 bg-white p-4 shadow-sm">
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <ShieldAlert className="mt-0.5 h-8 w-8 shrink-0 text-rose-600" />
                <div className="min-w-0">
                  <h2 className="text-start text-lg font-bold text-rose-800">
                    واتساب أوقف هذا الرقم
                  </h2>
                  {phone ? (
                    <p className="mt-1 text-start text-sm font-bold text-rose-800">
                      الرقم:{" "}
                      <span dir="ltr" className="font-mono">
                        {phone}
                      </span>
                    </p>
                  ) : null}
                  <p className="mt-1 text-start text-sm leading-7 text-slate-700">
                    حظر واتساب هذا الرقم أو علّقه، والإرسال التلقائي متوقف الآن. هذا ما يحدث عادةً
                    عند إرسال عدد كبير من الرسائل المتشابهة في وقت قصير أو عند تبليغ أولياء الأمور
                    عنها. لا تحاول الربط مرة أخرى بنفس الرقم فوراً — راجع حسابك من داخل واتساب
                    أولاً، وقدّم اعتراضاً إن كان الحظر مؤقتاً.
                  </p>
                </div>
              </div>

              {serverWarning ? <ErrorLine>{serverWarning}</ErrorLine> : null}
              <ManualFallbackNote />

              <div className="flex flex-wrap items-center gap-2">
                {refreshButton}
                <Button variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
                  ربط رقم آخر
                </Button>
                <ConfirmButton
                  confirmLabel="تأكيد فصل الحساب؟"
                  disabled={busy}
                  onConfirm={() => unlink.mutate()}
                >
                  فصل الحساب
                </ConfirmButton>
              </div>
            </div>
          </section>
        ) : null}

        {/* ─────────────────── ERROR ──────────────────────────────────── */}
        {screen === "FAULT" ? (
          <section className="overflow-hidden rounded-xl border border-rose-300 bg-white p-4 shadow-sm">
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <ShieldAlert className="mt-0.5 h-8 w-8 shrink-0 text-rose-600" />
                <div className="min-w-0">
                  <h2 className="text-start text-lg font-bold text-rose-800">
                    تعذّر الاتصال بخدمة الربط
                  </h2>
                  <p className="mt-1 text-start text-sm leading-7 text-slate-700">
                    الخدمة لم تردّ كما هو متوقع. الأسباب المعتادة: بيانات idInstance أو
                    apiTokenInstance غير صحيحة، أو انتهاء صلاحية الاشتراك في green-api.com، أو
                    انقطاع مؤقت في الشبكة.
                  </p>
                </div>
              </div>

              {serverWarning ? <ErrorLine>{serverWarning}</ErrorLine> : null}
              {refresh.isError ? <ErrorLine>{errorMessage(refresh.error)}</ErrorLine> : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={busy} onClick={() => refresh.mutate()}>
                  {refresh.isPending ? "جارٍ المحاولة…" : "إعادة المحاولة"}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
                  تعديل بيانات الربط
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void openExternal(GREEN_API_URL)}
                >
                  <ExternalLink className="h-4 w-4" />
                  فتح green-api.com
                </Button>
              </div>

              <ManualFallbackNote />
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export default WhatsappLink;
