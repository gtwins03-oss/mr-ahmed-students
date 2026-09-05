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
 */

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Server, XCircle } from "lucide-react";

import { apiUrl, getApiBase, isNativeApp, normaliseApiBase, setApiBase } from "../lib/apiBase";
import { getToken } from "../lib/auth";
import { reconnectRealtime } from "../lib/socket";
import { arNum } from "../lib/format";
import { Button, Card, Input, PageHeader } from "../components/ui";

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

function ResultLine({ result }: { result: TestResult }) {
  const tone = result.ok
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : "border-rose-200 bg-rose-50 text-rose-700";
  const Icon = result.ok ? CheckCircle2 : XCircle;
  return (
    <p
      role="status"
      aria-live="polite"
      className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm font-medium ${tone}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="text-start">{result.message}</span>
    </p>
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
    <div className="mx-auto w-full max-w-lg px-4 py-8 sm:py-12">
      <PageHeader
        title="إعداد الخادم"
        subtitle="عنوان الجهاز الذي يعمل عليه خادم النظام"
      />

      <Card>
        <div className="space-y-4">
          <p className="text-start text-sm leading-7 text-slate-600">
            اكتب عنوان الخادم كما يظهر على الجهاز الذي يشغّله، مثل{" "}
            <span dir="ltr" className="font-mono text-slate-800">
              http://192.168.1.10:4000
            </span>{" "}
            — يكفي أن يكون الجهازان على نفس شبكة الواي فاي. لا حاجة لكتابة
            <span dir="ltr" className="px-1 font-mono">
              /api
            </span>
            في نهاية العنوان.
          </p>

          <Input
            label="عنوان الخادم"
            dir="ltr"
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

          <p className="text-start text-xs text-slate-500">
            العنوان المستخدم حالياً:{" "}
            <span dir="ltr" className="font-mono text-slate-700">
              {current || "نفس موقع الصفحة"}
            </span>
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => void runTest()} disabled={testing}>
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

            <Button onClick={save} disabled={testing}>
              حفظ والمتابعة
            </Button>

            {current !== "" && (
              <Button
                variant="ghost"
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
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-start text-sm font-medium text-amber-800">
              التطبيق يعمل كتطبيق مثبَّت على الهاتف، ولا بد من تحديد عنوان الخادم قبل تسجيل
              الدخول.
            </p>
          )}

          <p className="text-start text-xs text-slate-500">
            <Link to={backTo} className="underline underline-offset-4 hover:text-slate-700">
              الرجوع
            </Link>
          </p>
        </div>
      </Card>
    </div>
  );
}

export default ServerSetup;
