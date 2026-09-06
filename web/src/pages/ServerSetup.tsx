/**
 * «إعداد الخادم» — where the app is told which machine to talk to.
 *
 * In a browser this screen is almost never needed: the page and the API share
 * an origin. It exists for the Android APK, which is served from
 * `capacitor://localhost` and has no dev proxy, so without an address here it
 * has nobody to talk to. It is a public route — a teacher locked out by a
 * wrong address must be able to fix it *before* logging in — and it is linked
 * from both the login screen and الإعدادات.
 *
 * The connection test deliberately does not go through `api/client.ts`: that
 * client points at the *saved* address, and the whole point here is to probe a
 * candidate one before committing to it.
 *
 * It renders outside the app shell, so it borrows the login screen's furniture:
 * the brand lockup on the bare canvas above a single card. «رجوع» is hidden in
 * exactly the situation where it would be a dead end — the APK with no address
 * stored, which `RequireAuth` would immediately bounce back to this page.
 */

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, Server, XCircle } from "lucide-react";

import {
  apiUrl,
  getApiBase,
  isApiBaseConfigured,
  isNativeApp,
  normaliseApiBase,
  setApiBase,
} from "../lib/apiBase";
import { getToken } from "../lib/auth";
import { reconnectRealtime } from "../lib/socket";
import { arNum } from "../lib/format";
import { LogoLockup } from "../components/Brand";
import { Button, Card, Input, cn } from "../components/ui";

/** A probe must not hang as long as a real request; the teacher is watching. */
const PROBE_TIMEOUT_MS = 8_000;

type TestResult = { ok: boolean; message: string };

/** GET {base}/api/health — the one endpoint that answers without a token. */
async function testConnection(base: string): Promise<TestResult> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  let res: Response;
  let text: string;
  try {
    res = await fetch(apiUrl("/health", base), {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      signal: controller.signal,
    });
    text = await res.text();
  } catch {
    return {
      ok: false,
      message: controller.signal.aborted
        ? "انتهت مهلة الاتصال. الخادم لا يستجيب أو الشبكة ضعيفة."
        : "تعذّر الوصول إلى هذا العنوان. تأكد من تشغيل الخادم ومن أن الجهازين على نفس الشبكة.",
    };
  } finally {
    window.clearTimeout(timer);
  }

  if (!res.ok) {
    return { ok: false, message: `الخادم رد برمز ${arNum(res.status)} — تأكد من صحة العنوان.` };
  }

  try {
    const payload = JSON.parse(text) as { ok?: boolean };
    if (payload?.ok !== true) throw new Error("not-our-server");
  } catch {
    return { ok: false, message: "هذا العنوان يستجيب، لكنه ليس خادم النظام." };
  }

  return { ok: true, message: "تم الاتصال بالخادم بنجاح." };
}

/** Success and failure differ by icon, word and tint — never by colour alone. */
function ResultLine({ result }: { result: TestResult }) {
  const Icon = result.ok ? CheckCircle2 : XCircle;
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-start gap-2 rounded-2xl border border-[var(--border)] px-4 py-3 text-start text-sm font-semibold leading-6",
        result.ok
          ? "bg-[var(--present-soft)] text-[var(--present-ink)]"
          : "bg-[var(--absent-soft)] text-[var(--absent-ink)]",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{result.message}</span>
    </p>
  );
}

/** Inline monospace Latin inside an Arabic sentence, forced left-to-right. */
function Mono({ children }: { children: string }) {
  return (
    <span dir="ltr" className="font-mono text-[var(--ink)]">
      {children}
    </span>
  );
}

export function ServerSetup() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const current = getApiBase();
  const [value, setValue] = useState(current);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const candidate = normaliseApiBase(value);
  const native = isNativeApp();
  const backTo = getToken() ? "/" : "/login";

  /**
   * Going back is only offered when there is somewhere to go back *to*: inside
   * the APK with no address stored, `RequireAuth` sends the teacher straight
   * here again, and a button that loops is worse than no button.
   */
  const canGoBack = !native || isApiBaseConfigured();

  async function runTest() {
    setTesting(true);
    setResult(null);
    setResult(await testConnection(candidate));
    setTesting(false);
  }

  function save() {
    setApiBase(value);
    // Anything cached came from the previous server and is now a lie.
    queryClient.clear();
    reconnectRealtime();
    navigate(getToken() ? "/" : "/login", { replace: true });
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--bg)] px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-8 flex justify-center">
          <LogoLockup size={56} subtitle />
        </div>

        <Card title="إعداد الخادم">
          <div className="space-y-5">
            <p className="text-start text-sm leading-7 text-[var(--ink-2)]">
              اكتب عنوان الخادم كما يظهر على الجهاز الذي يشغّله، مثل{" "}
              <Mono>http://192.168.1.10:4000</Mono> — يكفي أن يكون الجهازان على نفس شبكة الواي
              فاي. لا حاجة لكتابة <Mono>/api</Mono> في نهاية العنوان.
            </p>

            <Input
              label="عنوان الخادم"
              dir="ltr"
              className="font-mono"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="http://192.168.1.10:4000"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setResult(null);
              }}
            />

            <p className="text-start text-xs text-[var(--ink-3)]">
              العنوان المستخدم حالياً:{" "}
              <span dir="ltr" className="font-mono text-[var(--ink-2)]">
                {current || "نفس موقع الصفحة"}
              </span>
            </p>

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Button
                variant="secondary"
                onClick={() => void runTest()}
                disabled={testing}
                className="w-full sm:w-auto"
              >
                {testing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    جارٍ الاختبار…
                  </>
                ) : (
                  <>
                    <Server className="h-4 w-4" aria-hidden />
                    اختبار الاتصال
                  </>
                )}
              </Button>

              <Button onClick={save} disabled={testing} className="w-full sm:w-auto">
                حفظ والمتابعة
              </Button>

              {current !== "" && (
                <Button
                  variant="ghost"
                  className="w-full sm:w-auto"
                  onClick={() => {
                    setValue("");
                    setResult(null);
                  }}
                >
                  استخدام نفس موقع الصفحة
                </Button>
              )}
            </div>

            {result && <ResultLine result={result} />}

            {native && current === "" && (
              <p
                role="status"
                className="flex items-start gap-2 rounded-2xl border border-[var(--border)] bg-[var(--late-soft)] px-4 py-3 text-start text-sm font-semibold leading-6 text-[var(--late-ink)]"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  التطبيق يعمل كتطبيق مثبَّت على الهاتف، ولا بد من تحديد عنوان الخادم قبل تسجيل
                  الدخول.
                </span>
              </p>
            )}
          </div>
        </Card>

        {canGoBack && (
          <div className="mt-5 flex justify-center">
            <Link
              to={backTo}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-xl px-2 py-1 text-xs font-semibold text-[var(--ink-2)] transition-colors duration-150 hover:text-[var(--ink)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
              )}
            >
              {/* RTL: "back" points at the start edge, which is the right. */}
              <ArrowRight className="h-4 w-4" aria-hidden />
              رجوع
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

export default ServerSetup;
