/**
 * The brand: one mark, one wordmark, one lockup.
 *
 * The mark is an inline SVG rather than a raster asset so it stays crisp at
 * every size and picks up --brand from whichever theme is painted. It is never
 * stretched (always a square), never recoloured per page, and never animated.
 *
 * The wordmark is Latin text inside an RTL document, so each line carries
 * dir="ltr" — without it the browser reorders "Mr Ahmed Ibrahim" around the
 * surrounding Arabic run.
 */

import type { CSSProperties } from "react";

import { cn } from "./ui";

/* ──────────────────────────────── the mark ────────────────────────────── */

export interface LogoProps {
  /** Rendered edge length in px. The corner radius is always 26% of it. */
  size?: number;
  className?: string;
  /**
   * Accessible name. Omit when the mark sits beside the wordmark — the text
   * already names the product and a second announcement is noise.
   */
  title?: string;
}

/**
 * A rounded-square tile in --brand carrying a white graduation cap.
 *
 * Drawn on a 100×100 grid: the mortarboard is the diamond
 * (50,24)→(88,42)→(50,60)→(12,42), the cap body hangs beneath it, and the
 * tassel falls from the right corner of the brim.
 */
export function Logo({ size = 36, className, title }: LogoProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <rect width="100" height="100" rx="26" fill="var(--brand)" />
      <g fill="var(--brand-contrast)">
        <path d="M50 24 88 42 50 60 12 42Z" />
        <path d="M31 50.5V63c0 6.2 8.5 10.5 19 10.5S69 69.2 69 63V50.5L50 59.5Z" />
        <rect x="81.8" y="43.5" width="4.4" height="15" rx="2.2" />
        <circle cx="84" cy="65" r="4.6" />
      </g>
    </svg>
  );
}

/* ────────────────────────────── the wordmark ──────────────────────────── */

export interface WordmarkProps {
  className?: string;
  /** Font size of the first line in px; the STUDENTS line stays at 10px. */
  size?: number;
}

/** "Mr Ahmed Ibrahim" over a letterspaced "STUDENTS". */
export function Wordmark({ className, size = 15 }: WordmarkProps) {
  const titleStyle: CSSProperties = { fontSize: `${size}px` };
  return (
    <span className={cn("flex min-w-0 flex-col items-start leading-none", className)}>
      <span
        dir="ltr"
        style={titleStyle}
        className="truncate font-semibold text-[var(--ink)]"
      >
        Mr Ahmed Ibrahim
      </span>
      <span
        dir="ltr"
        className="mt-1 text-[10px] font-semibold tracking-[0.2em] text-[var(--ink-3)]"
      >
        STUDENTS
      </span>
    </span>
  );
}

/* ─────────────────────────────── the lockup ───────────────────────────── */

export interface LogoLockupProps {
  size?: number;
  className?: string;
  /** Adds the Arabic supporting line under the wordmark. */
  subtitle?: boolean;
}

export const BRAND_NAME = "Mr Ahmed Ibrahim Students";
export const BRAND_SUBTITLE = "مستر أحمد إبراهيم — إدارة الطلاب";

/** Mark + wordmark, optionally over the Arabic supporting line. */
export function LogoLockup({ size = 40, className, subtitle = false }: LogoLockupProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-w-0 items-center gap-3">
        <Logo size={size} title={BRAND_NAME} />
        <Wordmark />
      </div>
      {subtitle && (
        <p className="truncate text-start text-xs text-[var(--ink-3)]">{BRAND_SUBTITLE}</p>
      )}
    </div>
  );
}

export default LogoLockup;
