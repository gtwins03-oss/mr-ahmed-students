/**
 * Dark ⇄ light. Dark is the default; the choice is remembered under
 * "tutor.theme" and re-applied before first paint by the script in index.html.
 *
 * Two shapes, one behaviour: an icon button for a tight header, and a full
 * row for the sidebar footer and the mobile «المزيد» sheet.
 */

import { Moon, Sun } from "lucide-react";

import { useTheme } from "../lib/theme";
import { cn } from "./ui";

export interface ThemeToggleProps {
  /** Renders the label beside the icon, as a full-width row. */
  showLabel?: boolean;
  className?: string;
}

export function ThemeToggle({ showLabel = false, className }: ThemeToggleProps) {
  const [theme, setTheme] = useTheme();
  const isDark = theme === "dark";

  const nextLabel = isDark ? "الوضع الفاتح" : "الوضع الداكن";
  const Icon = isDark ? Sun : Moon;

  const toggle = () => setTheme(isDark ? "light" : "dark");

  if (showLabel) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label={`التبديل إلى ${nextLabel}`}
        className={cn(
          "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-sm font-semibold text-[var(--ink-2)] transition-colors duration-150 hover:bg-[var(--surface-2)] hover:text-[var(--ink)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
          className,
        )}
      >
        <Icon className="h-5 w-5 shrink-0" aria-hidden />
        <span className="flex-1 text-start">{nextLabel}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`التبديل إلى ${nextLabel}`}
      title={nextLabel}
      className={cn(
        "inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink-2)] transition-colors duration-150 hover:bg-[var(--surface-3)] hover:text-[var(--ink)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
        className,
      )}
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden />
    </button>
  );
}

export default ThemeToggle;
