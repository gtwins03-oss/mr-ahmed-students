/**
 * Route table and access control.
 *
 * The page components live in `src/pages/` and are resolved through Vite's
 * `import.meta.glob` rather than named static imports. The reason is practical:
 * the shell and the pages are built independently, and a page file that is
 * named `AssessmentDetail.tsx` instead of `GradeEntry.tsx` should degrade to a
 * single visibly-missing screen rather than breaking the whole build. Every
 * matched module is bundled eagerly — this is a small internal tool, so there
 * is nothing to gain from code-splitting a dozen tiny pages.
 *
 * Permissions, exactly as the owner asked for them:
 *  - ASSISTANT may do everything with *data*: students, classes, attendance,
 *    grades, messages, templates, settings. Nothing here restricts that.
 *  - OWNER only: the audit log and user management. A non-owner who types
 *    /audit is redirected to the dashboard — never shown a "ممنوع" page, which
 *    would confirm the route exists. The API returns 403 regardless; this is
 *    the cosmetic half of the same rule.
 */

import { useEffect, type ComponentType } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { AUTH_EXPIRED_EVENT } from "./api/client";
import { isApiBaseConfigured, isNativeApp } from "./lib/apiBase";
import { getToken, useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { EmptyState, LoadingBlock, PageHeader } from "./components/ui";

/* ───────────────────────── page resolution ────────────────────────────── */

type PageModule = Record<string, unknown>;

const PAGE_MODULES = import.meta.glob("./pages/**/*.tsx", { eager: true }) as Record<
  string,
  PageModule
>;

/** "./pages/Students.tsx" → "Students"; "./pages/Students/index.tsx" → "Students". */
const MODULES_BY_NAME = new Map<string, PageModule>();
for (const [path, mod] of Object.entries(PAGE_MODULES)) {
  const segments = path.split("/");
  const base = (segments[segments.length - 1] ?? "").replace(/\.tsx$/, "");
  const folder = segments[segments.length - 2];
  MODULES_BY_NAME.set(base, mod);
  if (base === "index" && folder && folder !== "pages") MODULES_BY_NAME.set(folder, mod);
}

function MissingPage({ candidates }: { candidates: string[] }) {
  return (
    <>
      <PageHeader title="الصفحة غير متوفرة" />
      <EmptyState
        title="لم يتم العثور على مكوّن هذه الصفحة"
        hint={`المتوقع أحد الملفات التالية داخل src/pages: ${candidates
          .map((name) => `${name}.tsx`)
          .join("، ")}`}
      />
    </>
  );
}

/**
 * Returns the first page component matching one of `candidates`, accepting
 * either a default export or a named export matching the file name.
 */
function page(...candidates: string[]): ComponentType {
  for (const name of candidates) {
    const mod = MODULES_BY_NAME.get(name);
    if (!mod) continue;
    const component = (mod.default ?? mod[name]) as ComponentType | undefined;
    if (component) return component;
  }
  return function NotFoundPage() {
    return <MissingPage candidates={candidates} />;
  };
}

const Dashboard = page("Dashboard", "DashboardPage", "Home");
const Students = page("Students", "StudentsPage", "StudentsList", "StudentList");
const StudentDetail = page("StudentDetail", "StudentDetailPage", "StudentProfile", "StudentPage");
const Classes = page("Classes", "ClassesPage", "ClassGroups", "ClassList");
const Attendance = page("Attendance", "AttendancePage", "AttendanceBoard");
const Grades = page("Grades", "GradesPage", "Assessments", "AssessmentsPage");
const GradeEntry = page(
  "GradeEntry",
  "GradeEntryPage",
  "GradeDetail",
  "AssessmentDetail",
  "AssessmentPage",
);
const Messages = page("Messages", "MessagesPage", "SendQueue", "Queue");
const WhatsappLink = page("WhatsappLink", "WhatsappLinkPage", "WhatsApp", "Whatsapp");
const Settings = page("Settings", "SettingsPage");
const Login = page("Login", "LoginPage", "SignIn", "SignInPage");
const ServerSetup = page("ServerSetup", "ServerSetupPage", "ServerAddress");
const Users = page("Users", "UsersPage", "UserManagement", "Accounts");
const AuditLog = page("AuditLog", "AuditLogPage", "Audit", "ActivityLog", "Activity");

/* ──────────────────────────── auth guards ─────────────────────────────── */

/**
 * The session is "possibly valid" as soon as a token exists on the device —
 * before the profile behind it has come back from the server. Redirecting on
 * `user === null` alone would bounce every cold start to /login on a slow
 * connection, so a stored token holds the route while the profile loads. If
 * the token turns out to be dead the API answers 401, `api/client.ts` clears
 * it and fires `auth:expired`, and the redirect happens then.
 */
function RequireAuth() {
  const { user } = useAuth();
  const location = useLocation();

  // Inside the APK there is no same-origin server to fall back on: without an
  // address, every request — including the login POST — is doomed.
  if (isNativeApp() && !isApiBaseConfigured()) {
    return <Navigate to="/server-setup" replace />;
  }

  if (!user && !getToken()) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <Outlet />;
}

/** Owner-only branch: assistants are sent home, not shown a 403 screen. */
function RequireOwner() {
  const { user, isOwner, isLoading } = useAuth();

  // Still restoring the session — deciding now would eject a legitimate owner.
  if (isLoading || (!user && getToken())) return <LoadingBlock />;
  if (!isOwner) return <Navigate to="/" replace />;

  return <Outlet />;
}

/** Sends the app to the login screen the moment a request is refused with 401. */
function useAuthExpiredRedirect(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const onExpired = () => navigate("/login", { replace: true });
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [navigate]);
}

/* ───────────────────────────── routes ─────────────────────────────────── */

function NotFound() {
  return (
    <>
      <PageHeader title="٤٠٤" />
      <EmptyState title="الصفحة غير موجودة" hint="تأكد من الرابط أو ارجع إلى لوحة التحكم." />
    </>
  );
}

export function App() {
  useAuthExpiredRedirect();

  return (
    <Routes>
      {/* Public: reachable with no token, and without the app shell. */}
      <Route path="/login" element={<Login />} />
      <Route path="/server-setup" element={<ServerSetup />} />

      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/students" element={<Students />} />
          <Route path="/students/:id" element={<StudentDetail />} />
          <Route path="/classes" element={<Classes />} />
          <Route path="/attendance" element={<Attendance />} />
          <Route path="/grades" element={<Grades />} />
          <Route path="/grades/:id" element={<GradeEntry />} />
          <Route path="/messages" element={<Messages />} />
          {/* Linking the sending number is a data task, not an owner one: an
              assistant who can send the messages can also fix the link. */}
          <Route path="/whatsapp" element={<WhatsappLink />} />
          <Route path="/settings" element={<Settings />} />

          {/* الأستاذ أحمد only. */}
          <Route element={<RequireOwner />}>
            <Route path="/users" element={<Users />} />
            <Route path="/audit" element={<AuditLog />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}

export default App;
