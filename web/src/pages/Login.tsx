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
 *
 * Visually this is the brand's front door — the lockup at full size on the bare
 * canvas, one card, and the server address printed quietly underneath so that a
 * teacher on the wrong network can see *why* nothing works before he types a
 * password.
 */

import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { AlertCircle, Eye, EyeOff, ServerCog } from "lucide-react";

import { ApiError, errorMessage } from "../api/client";
import { getApiBase } from "../lib/apiBase";
import { useAuth } from "../lib/auth";
import { LogoLockup } from "../components/Brand";
import { Button, Card, Input, LoadingBlock, cn } from "../components/ui";

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

/**
 * Vertical offset of the input box inside `<Input label=…>`: the label is
 * text-xs (16px line) plus its 6px margin. The eye button is laid over exactly
 * that box so it is centred on the field and not on the label above it.
 */
const FIELD_TOP = "top-[22px]";

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
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
        <LoadingBlock label="جارٍ التحقق من الجلسة…" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--bg)] px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <LogoLockup size={56} subtitle />
        </div>

        <Card>
          {/* A native form, so Enter submits from either field. */}
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
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
                className="pe-12"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                className={cn(
                  "absolute end-1 flex h-[46px] w-11 items-center justify-center rounded-2xl text-[var(--ink-3)] transition-colors duration-150 hover:text-[var(--ink)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
                  FIELD_TOP,
                )}
              >
                {showPassword ? (
                  <EyeOff className="h-[18px] w-[18px]" aria-hidden />
                ) : (
                  <Eye className="h-[18px] w-[18px]" aria-hidden />
                )}
              </button>
            </div>

            {error !== "" && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-2xl border border-[var(--border)] bg-[var(--absent-soft)] px-4 py-3 text-start text-sm font-semibold leading-6 text-[var(--absent-ink)]"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{error}</span>
              </p>
            )}

            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "جارٍ تسجيل الدخول…" : "تسجيل الدخول"}
            </Button>
          </form>
        </Card>

        {/* Where this app is pointed, in plain sight — the single most useful
            fact when the password is right and the login still fails. */}
        <div className="mt-5 flex flex-col items-center gap-1.5">
          <Link
            to="/server-setup"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-xl px-2 py-1 text-xs font-semibold transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
              offline
                ? "text-[var(--brand-ink)] underline underline-offset-4"
                : "text-[var(--ink-2)] hover:text-[var(--ink)]",
            )}
          >
            <ServerCog className="h-4 w-4" aria-hidden />
            إعداد الخادم
          </Link>
          <p dir="ltr" className="max-w-full truncate text-xs text-[var(--ink-3)]">
            {getApiBase() || "same-origin"}
          </p>
        </div>

        <p className="mt-6 text-center text-xs leading-6 text-[var(--ink-3)]">
          لا تعرف بياناتك؟ اطلب من الأستاذ إنشاء حساب لك من صفحة المستخدمين.
        </p>
      </div>
    </div>
  );
}

export default Login;
