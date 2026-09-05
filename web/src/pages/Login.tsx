import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { Eye, EyeOff, GraduationCap, ServerCog } from "lucide-react";

import { ApiError, errorMessage } from "../api/client";
import { getApiBase } from "../lib/apiBase";
import { useAuth } from "../lib/auth";
import { Button, Input, LoadingBlock } from "../components/ui";

/**
 * The one screen an assistant sees before anything else.
 *
 * Two failure modes matter and they need different words:
 *  - wrong credentials → the server answered, so show its Arabic message;
 *  - no answer at all (`ApiError.isNetworkError`) → the phone is offline or the
 *    stored server address is wrong, so point at «إعداد الخادم» right here
 *    instead of sending the teacher hunting through settings he cannot reach
 *    without logging in first.
 *
 * There is no imperative redirect after a successful sign-in: `useAuth()`
 * publishes the new user, this component re-renders, and the `<Navigate>`
 * below takes the teacher back to whatever page bounced him here.
 */

const NETWORK_HINT =
  "تعذّر الاتصال بالخادم — تأكد من الإنترنت أو من عنوان الخادم في الإعدادات";

function isNetworkFailure(error: unknown): boolean {
  return error instanceof ApiError && error.isNetworkError;
}

function readableError(error: unknown): string {
  if (isNetworkFailure(error)) return NETWORK_HINT;
  if (error instanceof ApiError && error.status === 401) {
    return error.message || "اسم المستخدم أو كلمة المرور غير صحيحة.";
  }
  return errorMessage(error);
}

/** `RequireAuth` stores the blocked path in the navigation state. */
function readFrom(state: unknown): string {
  if (typeof state === "object" && state !== null) {
    const { from } = state as { from?: unknown };
    if (typeof from === "string" && from.startsWith("/") && !from.startsWith("/login")) {
      return from;
    }
  }
  return "/";
}

export function Login() {
  const { user, login, isLoading } = useAuth();
  const location = useLocation();
  const from = readFrom(location.state);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    if (username.trim() === "" || password === "") {
      setError("اكتب اسم المستخدم وكلمة المرور.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await login(username, password);
    } catch (err) {
      setOffline(isNetworkFailure(err));
      setError(readableError(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  if (user !== null) return <Navigate to={from} replace />;

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <LoadingBlock label="جارٍ التحقق من الجلسة…" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-sm">
            <GraduationCap className="h-7 w-7" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-slate-900">نظام إدارة الطلاب</h1>
            <p className="mt-1 text-sm text-slate-500">سجّل الدخول للمتابعة</p>
          </div>
        </div>

        <form
          onSubmit={(event) => void submit(event)}
          className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <Input
            label="اسم المستخدم"
            dir="ltr"
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />

          <div className="relative">
            <Input
              label="كلمة المرور"
              dir="ltr"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              className="pe-11"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
              className="absolute end-2 top-8 rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {error ? (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium leading-6 text-rose-700">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "جارٍ تسجيل الدخول…" : "تسجيل الدخول"}
          </Button>

          <div className="border-t border-slate-100 pt-3 text-center">
            <Link
              to="/server-setup"
              className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold transition-colors hover:bg-slate-100 ${
                offline ? "text-blue-700 underline" : "text-slate-500"
              }`}
            >
              <ServerCog className="h-4 w-4" />
              تغيير عنوان الخادم
            </Link>
            <p className="mt-1 text-[11px] text-slate-400" dir="ltr">
              {getApiBase() || "same-origin"}
            </p>
          </div>
        </form>

        <p className="mt-4 text-center text-xs text-slate-400">
          لا تعرف بياناتك؟ اطلب من الأستاذ إنشاء حساب لك من صفحة المستخدمين.
        </p>
      </div>
    </div>
  );
}

export default Login;
