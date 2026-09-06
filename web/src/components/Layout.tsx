/**
 * App shell.
 *
 * RTL note: `dir="rtl"` is set on <html>, so inline-start is the *right* edge.
 * The sidebar is therefore anchored with `start-0` — it sits on the right —
 * and the content is pushed away from it with `ms-[264px]`. No `right-`/
 * `left-` utilities anywhere.
 *
 * Under `md` the sidebar becomes a five-item bottom tab bar, because the
 * teacher uses this on a phone while standing in front of a class. Four
 * destinations are the day's work; everything else — including the owner's two
 * administrative screens — lives behind «المزيد», which opens a sheet. That
 * keeps every tab a full-sized tap target instead of squeezing ten columns
 * into a phone's width.
 *
 * This is also where the app's connection story is mounted: `useRealtimeSync()`
 * opens the socket exactly once, and `<ConnectionBar />` is the only thing that
 * ever tells the user about the network.
 */

import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  ClipboardCheck,
  GraduationCap,
  History,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  QrCode,
  Send,
  Settings as SettingsIcon,
  User,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";

import { api } from "../api/client";
import type { Message, WhatsappStatus } from "../api/types";
import { arNum } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useRealtimeSync } from "../lib/socket";
import { BRAND_SUBTITLE, LogoLockup } from "./Brand";
import { ConnectionBar } from "./ConnectionBar";
import { ThemeToggle } from "./ThemeToggle";
import { Sheet, cn } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Only "/" should match exactly; the rest match their sub-routes too. */
  end?: boolean;
  /** Shows the pending-messages counter. */
  showsPendingBadge?: boolean;
  /** Shows a green dot while the WhatsApp sending account is linked. */
  showsLinkedDot?: boolean;
}

const DASHBOARD: NavItem = { to: "/", label: "لوحة التحكم", icon: LayoutDashboard, end: true };
const STUDENTS: NavItem = { to: "/students", label: "الطلاب", icon: Users };
const CLASSES: NavItem = { to: "/classes", label: "المجموعات", icon: BookOpen };
const ATTENDANCE: NavItem = { to: "/attendance", label: "الحضور", icon: ClipboardCheck };
const GRADES: NavItem = { to: "/grades", label: "الدرجات", icon: GraduationCap };
const MESSAGES: NavItem = {
  to: "/messages",
  label: "قائمة الإرسال",
  icon: Send,
  showsPendingBadge: true,
};
const WHATSAPP: NavItem = {
  to: "/whatsapp",
  label: "ربط واتساب",
  icon: QrCode,
  showsLinkedDot: true,
};
const SETTINGS: NavItem = { to: "/settings", label: "الإعدادات", icon: SettingsIcon };

/** Every destination, in sidebar order. */
const NAV_ITEMS: NavItem[] = [
  DASHBOARD,
  STUDENTS,
  CLASSES,
  ATTENDANCE,
  GRADES,
  MESSAGES,
  WHATSAPP,
  SETTINGS,
];

/**
 * Owner-only. Assistants have full access to every piece of *data* in the
 * system; what they never see is who did what (/audit) and the accounts
 * themselves (/users). Hiding the links is cosmetic — the API answers 403 —
 * but it keeps the two roles from ever looking like a permissions maze.
 */
const OWNER_NAV_ITEMS: NavItem[] = [
  { to: "/audit", label: "سجل النشاط", icon: History },
  { to: "/users", label: "المستخدمون", icon: UserCog },
];

/** The four tabs the phone gets. The fifth column is «المزيد». */
const TAB_ITEMS: NavItem[] = [DASHBOARD, ATTENDANCE, GRADES, MESSAGES];

/** Everything the bottom bar does not carry, in the order the sheet lists it. */
const MORE_ITEMS: NavItem[] = [STUDENTS, CLASSES, WHATSAPP, SETTINGS];

/** Polls the outbox so the teacher always sees how many parents are waiting. */
function usePendingCount(): number {
  const { data } = useQuery({
    queryKey: ["messages", { status: "PENDING" }],
    queryFn: () => api.get<Message[]>("/messages?status=PENDING"),
    refetchInterval: 30_000,
  });
  return data?.length ?? 0;
}

/**
 * Whether the teacher's own WhatsApp number is currently linked. Shares its
 * query key with the /whatsapp page, so the two never fetch twice — and a
 * minute is plenty for a state that changes once every few months.
 */
function useWhatsappLinked(): boolean {
  const { data } = useQuery({
    queryKey: ["whatsapp", "status"],
    queryFn: () => api.get<WhatsappStatus>("/whatsapp/status"),
    refetchInterval: 60_000,
  });
  return data?.state === "AUTHORIZED";
}

/* ──────────────────────────────── badges ──────────────────────────────── */

/** Green = "الإرسال التلقائي شغّال"; its absence says nothing is broken. */
function LinkedDot({ className }: { className?: string }) {
  return (
    <span
      aria-label="واتساب مرتبط"
      title="واتساب مرتبط — الإرسال التلقائي يعمل"
      className={cn(
        "inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--present)] ring-2 ring-[var(--surface)]",
        className,
      )}
    />
  );
}

function PendingPill({ count, className }: { count: number; className?: string }) {
  return (
    <span
      aria-label={`${count} رسالة بانتظار الإرسال`}
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--absent)] px-1.5 text-xs font-bold leading-5 text-white",
        className,
      )}
    >
      {arNum(count)}
    </span>
  );
}

/* ─────────────────────────────── nav rows ─────────────────────────────── */

interface RowProps {
  item: NavItem;
  pendingCount: number;
  whatsappLinked: boolean;
  onNavigate?: () => void;
}

/** One line in the desktop sidebar or the «المزيد» sheet. */
function NavRow({ item, pendingCount, whatsappLinked, onNavigate }: RowProps) {
  const { to, label, icon: Icon, end, showsPendingBadge, showsLinkedDot } = item;
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm font-semibold transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
          isActive
            ? "bg-[var(--brand-soft)] text-[var(--brand)]"
            : "text-[var(--ink-2)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden
              className="absolute start-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-[var(--brand)]"
            />
          )}
          <Icon className="h-5 w-5 shrink-0" aria-hidden />
          <span className="flex-1 truncate text-start">{label}</span>
          {showsPendingBadge && pendingCount > 0 && <PendingPill count={pendingCount} />}
          {showsLinkedDot && whatsappLinked && <LinkedDot />}
        </>
      )}
    </NavLink>
  );
}

/**
 * The 3px pill that marks the live tab. Centred by a full-width flex row
 * rather than `start-1/2 + translate`, which mirrors the wrong way in RTL.
 */
function TabIndicator() {
  return (
    <span aria-hidden className="absolute inset-x-0 top-0 flex justify-center">
      <span className="h-[3px] w-6 rounded-full bg-[var(--brand)]" />
    </span>
  );
}

/** Name + role, used at the foot of the sidebar and inside the sheet. */
function AccountRow({ name, roleLabel }: { name: string; roleLabel: string }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--ink-3)]">
        <User className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 text-start">
        <p className="truncate text-sm font-semibold text-[var(--ink)]">{name}</p>
        <p className="text-xs text-[var(--ink-3)]">{roleLabel}</p>
      </div>
    </div>
  );
}

function LogoutRow({ onLogout }: { onLogout: () => void }) {
  return (
    <button
      type="button"
      onClick={onLogout}
      className={cn(
        "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-sm font-semibold text-[var(--ink-2)] transition-colors duration-150",
        "hover:bg-[var(--absent-soft)] hover:text-[var(--absent-ink)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
      )}
    >
      <LogOut className="h-5 w-5 shrink-0" aria-hidden />
      <span className="flex-1 text-start">تسجيل الخروج</span>
    </button>
  );
}

/* ──────────────────────────────── shell ───────────────────────────────── */

export function Layout({ children }: { children?: ReactNode }) {
  const pendingCount = usePendingCount();
  const whatsappLinked = useWhatsappLinked();
  const { user, isOwner, logout } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  // One socket for the whole app, opened here and closed on logout.
  useRealtimeSync();

  // A tap that navigates should never leave the sheet hanging over the page.
  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname]);

  /**
   * Signing out also empties the cache. The query cache is mirrored into
   * localStorage so the app opens instantly on a bad connection, and it holds
   * student names and parents' phone numbers — none of which may outlive the
   * session on a shared phone.
   */
  const handleLogout = () => {
    logout();
    queryClient.clear();
  };

  const ownerItems = isOwner ? OWNER_NAV_ITEMS : [];
  const sidebarItems = [...NAV_ITEMS, ...ownerItems];
  const moreItems = [...MORE_ITEMS, ...ownerItems];
  const displayName = user?.name ?? "المستخدم";
  const roleLabel = isOwner ? "المالك" : "مساعد";

  /** «المزيد» lights up whenever the open page lives behind it. */
  const moreActive = moreItems.some(
    ({ to }) => location.pathname === to || location.pathname.startsWith(`${to}/`),
  );

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* ── Desktop sidebar: inline-start === right edge in RTL ─────────── */}
      <aside className="fixed inset-y-0 start-0 z-40 hidden w-[264px] flex-col border-e border-[var(--border)] bg-[var(--surface)] md:flex">
        <div className="px-5 py-6">
          <LogoLockup size={40} subtitle />
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {sidebarItems.map((item) => (
            <NavRow
              key={item.to}
              item={item}
              pendingCount={pendingCount}
              whatsappLinked={whatsappLinked}
            />
          ))}
        </nav>

        <div className="space-y-1 border-t border-[var(--border)] p-3">
          <ThemeToggle showLabel />
          <AccountRow name={displayName} roleLabel={roleLabel} />
          <LogoutRow onLogout={handleLogout} />
        </div>
      </aside>

      {/* ── Mobile top bar + connection strip ───────────────────────────── */}
      {/* Both stick together so the network state is never scrolled away. */}
      <div className="sticky top-0 z-30 md:ms-[264px]">
        <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 md:hidden">
          <LogoLockup size={34} />
          <div className="flex items-center gap-2">
            {pendingCount > 0 && <PendingPill count={pendingCount} />}
            <ThemeToggle />
          </div>
        </header>
        <ConnectionBar />
      </div>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <main className="px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-6 md:ms-[264px] md:px-8 md:pb-12 md:pt-8">
        <div className="mx-auto w-full max-w-6xl">{children ?? <Outlet />}</div>
      </main>

      {/* ── Mobile bottom bar ───────────────────────────────────────────── */}
      <nav
        aria-label="التنقل الرئيسي"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {TAB_ITEMS.map(({ to, label, icon: Icon, end, showsPendingBadge }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "relative flex flex-col items-center gap-1 px-0.5 pb-2 pt-2.5 text-[10px] font-semibold transition-colors duration-150",
                isActive ? "text-[var(--brand)]" : "text-[var(--ink-3)]",
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <TabIndicator />}
                <span className="relative">
                  <Icon className="h-5 w-5" aria-hidden />
                  {showsPendingBadge && pendingCount > 0 && (
                    <PendingPill
                      count={pendingCount}
                      className="absolute -top-1.5 end-[-10px] text-[9px]"
                    />
                  )}
                </span>
                <span className="w-full truncate text-center">{label}</span>
              </>
            )}
          </NavLink>
        ))}

        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={cn(
            "relative flex flex-col items-center gap-1 px-0.5 pb-2 pt-2.5 text-[10px] font-semibold transition-colors duration-150",
            moreActive || moreOpen ? "text-[var(--brand)]" : "text-[var(--ink-3)]",
          )}
        >
          {(moreActive || moreOpen) && <TabIndicator />}
          <span className="relative">
            <MoreHorizontal className="h-5 w-5" aria-hidden />
            {whatsappLinked && <LinkedDot className="absolute -top-1 end-[-6px]" />}
          </span>
          <span className="w-full truncate text-center">المزيد</span>
        </button>
      </nav>

      {/* ── «المزيد»: the rest of the app, on a phone ───────────────────── */}
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="المزيد">
        <p className="px-3 pb-2 text-start text-xs text-[var(--ink-3)]">{BRAND_SUBTITLE}</p>

        <div className="space-y-1">
          {moreItems.map((item) => (
            <NavRow
              key={item.to}
              item={item}
              pendingCount={pendingCount}
              whatsappLinked={whatsappLinked}
              onNavigate={() => setMoreOpen(false)}
            />
          ))}
        </div>

        <div className="mt-3 space-y-1 border-t border-[var(--border)] pt-3">
          <ThemeToggle showLabel />
          <AccountRow name={displayName} roleLabel={roleLabel} />
          <LogoutRow onLogout={handleLogout} />
        </div>
      </Sheet>
    </div>
  );
}

export default Layout;
