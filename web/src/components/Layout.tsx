/**
 * App shell.
 *
 * RTL note: `dir="rtl"` is set on <html>, so inline-start is the *right* edge.
 * The sidebar is therefore anchored with `start-0` and the content is pushed
 * away from it with `ms-64` — no `right-`/`left-` utilities anywhere.
 *
 * Under `md` the sidebar becomes a bottom tab bar, because the teacher uses
 * this on a phone while standing in front of a class. The bottom bar carries
 * the eight daily screens only; the owner's two administrative screens live in
 * the sidebar on desktop and in the account menu on mobile, so the tab bar
 * never shrinks below a usable tap target. Items whose label does not survive
 * a column that narrow carry a `shortLabel`.
 *
 * This is also where the app's connection story is mounted: `useRealtimeSync()`
 * opens the socket exactly once, and `<ConnectionBar />` is the only thing that
 * ever tells the user about the network.
 */

import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  ClipboardCheck,
  GraduationCap,
  History,
  LayoutDashboard,
  LogOut,
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
import { ConnectionBar } from "./ConnectionBar";
import { cn } from "./ui";

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
  /** Bottom-bar label, where a column is barely wider than the icon. */
  shortLabel?: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "لوحة التحكم", icon: LayoutDashboard, end: true },
  { to: "/students", label: "الطلاب", icon: Users },
  { to: "/classes", label: "المجموعات", icon: BookOpen },
  { to: "/attendance", label: "الحضور", icon: ClipboardCheck },
  { to: "/grades", label: "الدرجات", icon: GraduationCap },
  { to: "/messages", label: "قائمة الإرسال", icon: Send, showsPendingBadge: true },
  {
    to: "/whatsapp",
    label: "ربط واتساب",
    shortLabel: "واتساب",
    icon: QrCode,
    showsLinkedDot: true,
  },
  { to: "/settings", label: "الإعدادات", icon: SettingsIcon },
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

/** Green = "الإرسال التلقائي شغّال"; its absence says nothing is broken. */
function LinkedDot({ className }: { className?: string }) {
  return (
    <span
      aria-label="واتساب مرتبط"
      title="واتساب مرتبط — الإرسال التلقائي يعمل"
      className={cn(
        "inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500 ring-2 ring-white",
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
        "inline-flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1.5 text-xs font-bold leading-5 text-white shadow-sm",
        className,
      )}
    >
      {arNum(count)}
    </span>
  );
}

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
        <GraduationCap className="h-5 w-5" />
      </span>
      <span className="text-base font-bold text-slate-900">نظام إدارة الطلاب</span>
    </div>
  );
}

const NAV_LINK = (isActive: boolean) =>
  cn(
    "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors",
    isActive ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
  );

/** Account block at the foot of the desktop sidebar. */
function AccountPanel({
  name,
  roleLabel,
  onLogout,
}: {
  name: string;
  roleLabel: string;
  onLogout: () => void;
}) {
  return (
    <div className="border-t border-slate-100 p-3">
      <div className="flex items-center gap-2.5 px-2 py-1.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <User className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 text-start">
          <p className="truncate text-sm font-bold text-slate-800">{name}</p>
          <p className="text-xs text-slate-500">{roleLabel}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onLogout}
        className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-600 transition-colors hover:bg-rose-50 hover:text-rose-700"
      >
        <LogOut className="h-5 w-5 shrink-0" />
        <span className="flex-1 text-start">تسجيل الخروج</span>
      </button>
    </div>
  );
}

/** The same actions on a phone, folded into a menu beside the brand. */
function AccountMenu({
  name,
  roleLabel,
  ownerItems,
  onLogout,
}: {
  name: string;
  roleLabel: string;
  ownerItems: NavItem[];
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="حسابي"
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-36 items-center gap-2 rounded-xl border border-slate-200 px-2.5 py-1.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
      >
        <User className="h-4 w-4 shrink-0 text-slate-500" />
        <span className="truncate">{name}</span>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="إغلاق القائمة"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="menu"
            className="absolute end-0 top-full z-50 mt-2 w-56 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl"
          >
            <p className="px-3 py-2 text-start text-xs text-slate-500">{roleLabel}</p>
            {ownerItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                role="menuitem"
                onClick={() => setOpen(false)}
                className={({ isActive }) => NAV_LINK(isActive)}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className="flex-1 text-start">{label}</span>
              </NavLink>
            ))}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-600 transition-colors hover:bg-rose-50 hover:text-rose-700"
            >
              <LogOut className="h-5 w-5 shrink-0" />
              <span className="flex-1 text-start">تسجيل الخروج</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Layout({ children }: { children?: ReactNode }) {
  const pendingCount = usePendingCount();
  const whatsappLinked = useWhatsappLinked();
  const [year] = useState(() => new Date().getFullYear());
  const { user, isOwner, logout } = useAuth();
  const queryClient = useQueryClient();

  // One socket for the whole app, opened here and closed on logout.
  useRealtimeSync();

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

  const sidebarItems = isOwner ? [...NAV_ITEMS, ...OWNER_NAV_ITEMS] : NAV_ITEMS;
  const ownerItems = isOwner ? OWNER_NAV_ITEMS : [];
  const displayName = user?.name ?? "المستخدم";
  const roleLabel = isOwner ? "المالك" : "مساعد";

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ── Desktop sidebar: inline-start === right edge in RTL ─────────── */}
      <aside className="fixed inset-y-0 start-0 z-40 hidden w-64 flex-col border-e border-slate-200 bg-white md:flex">
        <div className="border-b border-slate-100 px-5 py-5">
          <BrandMark />
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {sidebarItems.map(({ to, label, icon: Icon, end, showsPendingBadge, showsLinkedDot }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => NAV_LINK(isActive)}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="flex-1 text-start">{label}</span>
              {showsPendingBadge && pendingCount > 0 && <PendingPill count={pendingCount} />}
              {showsLinkedDot && whatsappLinked && <LinkedDot />}
            </NavLink>
          ))}
        </nav>

        <AccountPanel name={displayName} roleLabel={roleLabel} onLogout={handleLogout} />

        <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-400">
          © {arNum(year)}
        </p>
      </aside>

      {/* ── Mobile top bar + connection strip ───────────────────────────── */}
      {/* Both stick together so the network state is never scrolled away. */}
      <div className="sticky top-0 z-30 md:ms-64">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur md:hidden">
          <BrandMark />
          <div className="flex items-center gap-2">
            {pendingCount > 0 && <PendingPill count={pendingCount} />}
            <AccountMenu
              name={displayName}
              roleLabel={roleLabel}
              ownerItems={ownerItems}
              onLogout={handleLogout}
            />
          </div>
        </header>
        <ConnectionBar />
      </div>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <main className="px-4 pb-24 pt-5 md:ms-64 md:px-8 md:pb-10 md:pt-8">
        <div className="mx-auto w-full max-w-6xl">{children ?? <Outlet />}</div>
      </main>

      {/* ── Mobile bottom bar ───────────────────────────────────────────── */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
        style={{ gridTemplateColumns: `repeat(${NAV_ITEMS.length}, minmax(0, 1fr))` }}
      >
        {NAV_ITEMS.map(
          ({ to, label, shortLabel, icon: Icon, end, showsPendingBadge, showsLinkedDot }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex flex-col items-center gap-1 py-2 text-[10px] font-semibold transition-colors",
                  isActive ? "text-blue-700" : "text-slate-500",
                )
              }
            >
              <span className="relative px-2">
                <Icon className="h-5 w-5" />
                {showsPendingBadge && pendingCount > 0 && (
                  <PendingPill count={pendingCount} className="absolute end-0 top-0 text-[9px]" />
                )}
                {showsLinkedDot && whatsappLinked && (
                  <LinkedDot className="absolute end-0 top-0" />
                )}
              </span>
              <span className="truncate">{shortLabel ?? label}</span>
            </NavLink>
          ),
        )}
      </nav>
    </div>
  );
}

export default Layout;
