/**
 * Every UI primitive in the app lives in this one file.
 *
 * Design rules baked in here:
 *  - RTL only. Spacing and positioning use logical properties (ps/pe, ms/me,
 *    start/end) so nothing has to be mirrored by hand.
 *  - Every colour comes from a token in index.css, consumed as
 *    `bg-[var(--surface)]`. Nothing here names a palette colour directly, so
 *    the light theme is a variable swap and not a second set of components.
 *  - One accent (--brand). Hairline borders. No drop shadows on dark. The
 *    signature is the size of the numbers, not decoration.
 *  - Generous tap targets. This is operated mid-class, one-handed, in a hurry.
 *  - Attendance semantics are fixed: حاضر --present · غائب --absent ·
 *    متأخر --late · بعذر --excused, and the Arabic word is always visible so
 *    colour never carries the meaning alone.
 *  - Dependency-free apart from react and lucide-react.
 *
 * Every primitive forwards its remaining props to the underlying element and
 * merges an optional `className`, so callers can specialise without wrapping.
 */

import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { ChevronDown, Loader2, X } from "lucide-react";

/** Joins class names, dropping falsy entries. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]";

/* ──────────────────────────────── Tones ───────────────────────────────── */

/**
 * The five semantic tones. `blue` is a historical alias for `brand`: there is
 * exactly one accent in this design and both names resolve to it.
 */
export type Tone = "brand" | "blue" | "green" | "red" | "amber" | "gray";

/** Kept as a separate name because pages import it. Same union. */
export type BadgeTone = Tone;

/** Solid fill for a tone — meters, dots, selected states. */
const TONE_FILL: Record<Tone, string> = {
  brand: "var(--brand)",
  blue: "var(--brand)",
  green: "var(--present)",
  red: "var(--absent)",
  amber: "var(--late)",
  gray: "var(--excused)",
};

/** Tinted pill + legible text of the same tone. */
const TONE_PILL: Record<Tone, string> = {
  brand: "bg-[var(--brand-soft)] text-[var(--brand-ink)]",
  blue: "bg-[var(--brand-soft)] text-[var(--brand-ink)]",
  green: "bg-[var(--present-soft)] text-[var(--present-ink)]",
  red: "bg-[var(--absent-soft)] text-[var(--absent-ink)]",
  amber: "bg-[var(--late-soft)] text-[var(--late-ink)]",
  gray: "bg-[var(--excused-soft)] text-[var(--excused-ink)]",
};

/* ──────────────────────────────── Button ──────────────────────────────── */

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--brand)] text-[var(--brand-contrast)] hover:bg-[var(--brand-hover)] active:bg-[var(--brand-active)]",
  secondary:
    "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink)] hover:bg-[var(--surface-3)] hover:border-[var(--border-strong)]",
  danger:
    "bg-[var(--absent)] text-white hover:bg-[var(--absent-hover)] active:bg-[var(--absent-active)]",
  ghost: "text-[var(--ink-2)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-9 gap-1.5 px-3.5 text-sm",
  md: "h-11 gap-2 px-5 text-sm sm:text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex select-none items-center justify-center rounded-2xl font-semibold transition-colors duration-150",
        "disabled:pointer-events-none disabled:opacity-40",
        FOCUS_RING,
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
});

/* ───────────────────────────────── Card ───────────────────────────────── */

export interface CardProps {
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Extra classes for the body wrapper, e.g. "p-0" for free tables. */
  bodyClassName?: string;
  children?: ReactNode;
}

/**
 * True when the caller has taken padding into its own hands — `bodyClassName`
 * carries a `p-*` utility (with or without a variant prefix). Two padding
 * declarations of equal specificity would otherwise resolve by whatever order
 * Tailwind happened to emit them in.
 */
function overridesPadding(className: string | undefined): boolean {
  return className !== undefined && /(^|\s)(?:[a-z-]+:)*-?p[xytrbsle]?-/.test(className);
}

export function Card({ title, actions, className, bodyClassName, children }: CardProps) {
  const hasHeader = title !== undefined || actions !== undefined;
  const padding = overridesPadding(bodyClassName)
    ? ""
    : hasHeader
      ? "px-5 pb-5 pt-4 sm:px-6 sm:pb-6"
      : "p-5 sm:p-6";

  return (
    <section
      className={cn(
        "elev overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--surface)]",
        className,
      )}
    >
      {hasHeader && (
        <header className="flex items-center justify-between gap-3 px-5 pt-5 sm:px-6 sm:pt-6">
          {title !== undefined ? (
            <h2 className="text-start text-base font-semibold text-[var(--ink)]">{title}</h2>
          ) : (
            <span />
          )}
          {actions !== undefined && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className={cn(padding, bodyClassName)}>{children}</div>
    </section>
  );
}

/* ────────────────────────────── Form fields ───────────────────────────── */

const FIELD_BASE =
  "block w-full rounded-2xl border bg-[var(--surface-2)] px-4 py-2.5 text-start text-[var(--ink)] transition-colors duration-150 placeholder:text-[var(--ink-3)] focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50";

const FIELD_OK =
  "border-[var(--border)] hover:border-[var(--border-strong)] focus:border-[var(--brand)] focus:ring-[var(--brand-soft)]";
const FIELD_ERROR =
  "border-[var(--absent)] focus:border-[var(--absent)] focus:ring-[var(--absent-soft)]";

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-start text-xs font-semibold text-[var(--ink-3)]"
    >
      {children}
    </label>
  );
}

function FieldError({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1.5 text-start text-xs font-semibold text-[var(--absent-ink)]">{children}</p>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div className="w-full">
      {label !== undefined && <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>}
      <input
        ref={ref}
        id={fieldId}
        aria-invalid={error ? true : undefined}
        className={cn(FIELD_BASE, error ? FIELD_ERROR : FIELD_OK, className)}
        {...rest}
      />
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, className, id, rows = 4, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div className="w-full">
      {label !== undefined && <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>}
      <textarea
        ref={ref}
        id={fieldId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        className={cn(FIELD_BASE, "leading-7", error ? FIELD_ERROR : FIELD_OK, className)}
        {...rest}
      />
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  error?: string;
  children: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, className, id, children, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div className="w-full">
      {label !== undefined && <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>}
      <div className="relative">
        <select
          ref={ref}
          id={fieldId}
          aria-invalid={error ? true : undefined}
          className={cn(
            FIELD_BASE,
            "appearance-none pe-10",
            error ? FIELD_ERROR : FIELD_OK,
            className,
          )}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-3)]"
        />
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
});

/* ──────────────────────────────── Badge ───────────────────────────────── */

export interface BadgeProps {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = "gray", className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        TONE_PILL[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The 8px dot that puts a colour beside a word without shouting. */
export function Dot({ tone = "gray", className }: { tone?: Tone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: TONE_FILL[tone] }}
    />
  );
}

/* ───────────────────────── Overlay plumbing ───────────────────────────── */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Locks the page behind an overlay: scroll frozen, Escape closes, Tab cycles
 * inside the panel, and focus returns to whatever opened it on the way out.
 */
function useOverlay(
  open: boolean,
  onClose: () => void,
  panelRef: { current: HTMLDivElement | null },
): void {
  // Callers pass an inline arrow, so `onClose` is a new function on every
  // render. Keeping it in a ref keeps the effect below keyed on `open` alone —
  // otherwise every re-render (the outbox poll ticks every 30s) would tear the
  // overlay down and steal focus back to its first control.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
    const restoreTo = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusables = (): HTMLElement[] => {
      if (!panel) return [];
      return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
      );
    };

    // Focus the first control so a keyboard user is already inside the panel.
    const initial = focusables()[0] ?? panel;
    initial?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;

      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);

      if (e.shiftKey ? active === first || !inside : active === last || !inside) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown, true);
      restoreTo?.focus?.();
    };
  }, [open, panelRef]);
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="إغلاق"
      className={cn(
        "-me-1 rounded-xl p-2 text-[var(--ink-3)] transition-colors duration-150 hover:bg-[var(--surface-2)] hover:text-[var(--ink)]",
        FOCUS_RING,
      )}
    >
      <X className="h-5 w-5" />
    </button>
  );
}

/* ──────────────────────────────── Modal ───────────────────────────────── */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, footer, className }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useOverlay(open, onClose, panelRef);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div
        className="anim-fade absolute inset-0 bg-[var(--scrim)]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          "anim-rise relative z-10 flex max-h-[92vh] w-full max-w-lg flex-col rounded-t-[20px] border border-[var(--border)] bg-[var(--surface)] outline-none sm:rounded-[20px]",
          className,
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4 sm:px-6">
          <h2 className="text-start text-base font-semibold text-[var(--ink)]">{title}</h2>
          <CloseButton onClose={onClose} />
        </header>

        <div className="flex-1 overflow-y-auto p-5 sm:p-6">{children}</div>

        {footer !== undefined && (
          <footer className="flex flex-wrap items-center justify-start gap-2 border-t border-[var(--border)] px-5 py-4 sm:px-6">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────────── Sheet ──────────────────────────────── */

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * The phone-shaped overlay: a panel that rises from the bottom edge, clears
 * the home indicator, and closes on Escape or a tap on the scrim.
 */
export function Sheet({ open, onClose, title, children, className }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useOverlay(open, onClose, panelRef);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div
        className="anim-fade absolute inset-0 bg-[var(--scrim)]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          "anim-sheet relative z-10 flex max-h-[85vh] w-full flex-col rounded-t-[20px] border-t border-[var(--border)] bg-[var(--surface)] outline-none",
          className,
        )}
      >
        {/* Grab handle: the only affordance that says "drag me away". */}
        <div className="flex justify-center pt-3" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-[var(--border-strong)]" />
        </div>

        <header className="flex items-center justify-between gap-3 px-5 py-3">
          <h2 className="text-start text-base font-semibold text-[var(--ink)]">{title}</h2>
          <CloseButton onClose={onClose} />
        </header>

        <div className="flex-1 overflow-y-auto px-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-1">
          {children}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── EmptyState ────────────────────────────── */

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon !== undefined && (
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--surface-2)] text-[var(--ink-3)]">
          {icon}
        </div>
      )}
      <p className="text-base font-semibold text-[var(--ink)]">{title}</p>
      {hint !== undefined && (
        <p className="max-w-sm text-sm leading-6 text-[var(--ink-2)]">{hint}</p>
      )}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}

/* ────────────────────────────── PageHeader ────────────────────────────── */

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-start text-2xl font-bold tracking-tight text-[var(--ink)]">{title}</h1>
        {subtitle !== undefined && (
          <p className="mt-1.5 text-start text-sm text-[var(--ink-2)]">{subtitle}</p>
        )}
      </div>
      {actions !== undefined && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/* ─────────────────────────────── Section ──────────────────────────────── */

export interface SectionProps {
  title: ReactNode;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/** A titled group of things. Same rhythm as a Card, without the border. */
export function Section({ title, action, className, children }: SectionProps) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-start text-base font-semibold text-[var(--ink)]">{title}</h2>
        {action !== undefined && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/* ─────────────────────────────── Spinner ──────────────────────────────── */

export function Spinner({ className }: { className?: string }) {
  return (
    <span role="status" aria-label="جارٍ التحميل" className="inline-flex">
      <Loader2 className={cn("h-5 w-5 animate-spin text-[var(--brand)]", className)} />
    </span>
  );
}

/** Centred spinner for a whole panel that is still loading. */
export function LoadingBlock({ label = "جارٍ التحميل…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-14 text-sm text-[var(--ink-2)]">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

/* ──────────────────────────────── Meter ───────────────────────────────── */

export interface MeterProps {
  value: number;
  /** Denominator. Defaults to 100, i.e. `value` is already a percentage. */
  max?: number;
  tone?: Tone;
  className?: string;
  /** Accessible name; the number beside the meter usually says it already. */
  label?: string;
}

/** A 6px track with a rounded fill. The whole chart vocabulary for a ratio. */
export function Meter({ value, max = 100, tone = "brand", className, label }: MeterProps) {
  const safeMax = max > 0 ? max : 100;
  const clamped = Math.max(0, Math.min(safeMax, Number.isFinite(value) ? value : 0));
  const pct = (clamped / safeMax) * 100;

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-label={label}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]", className)}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%`, backgroundColor: TONE_FILL[tone] }}
      />
    </div>
  );
}

/* ────────────────────────────── StatTile ──────────────────────────────── */

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  /** One line of context under the number — "من ٢٤ حصة". */
  hint?: ReactNode;
  /** Percentage 0–100. Draws a thin meter under the number. */
  meter?: number;
  tone?: Tone;
  /** 16px, muted, beside the label — never beside the value. */
  icon?: ReactNode;
  /** Small chip at the end of the label row, e.g. "+٣". */
  delta?: ReactNode;
  deltaTone?: Tone;
  className?: string;
}

/**
 * The dashboard signature: a quiet label, one very large number, one line of
 * context. No chart lives in here — a ratio gets `meter`, nothing else.
 */
export function StatTile({
  label,
  value,
  hint,
  meter,
  tone = "brand",
  icon,
  delta,
  deltaTone,
  className,
}: StatTileProps) {
  return (
    <div
      className={cn(
        "elev rounded-[20px] border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {icon !== undefined && (
          <span className="flex shrink-0 items-center text-[var(--ink-3)] [&>svg]:h-4 [&>svg]:w-4">
            {icon}
          </span>
        )}
        <p className="min-w-0 flex-1 truncate text-start text-xs font-semibold text-[var(--ink-3)]">
          {label}
        </p>
        {delta !== undefined && (
          <Badge tone={deltaTone ?? tone} className="shrink-0">
            {delta}
          </Badge>
        )}
      </div>

      <p className="mt-3 text-start text-4xl font-bold leading-none tracking-tight text-[var(--ink)]">
        {value}
      </p>

      {meter !== undefined && <Meter value={meter} tone={tone} className="mt-4" />}

      {hint !== undefined && (
        <p className="mt-2 text-start text-sm text-[var(--ink-2)]">{hint}</p>
      )}
    </div>
  );
}

/* ───────────────────────────── Sparkline ──────────────────────────────── */

export interface SparkPoint {
  /** What this point is — the assessment name. */
  label: string;
  value: number;
  /** Secondary line in the tooltip, normally the date. */
  hint?: string;
}

export interface SparklineProps {
  points: SparkPoint[];
  /** Plot height in px. */
  height?: number;
  /** Formats the value in the tooltip and the end label (pass `arNum`). */
  formatValue?: (value: number) => string;
  /** Shown when there are fewer than two points. */
  emptyTitle?: string;
  emptyHint?: string;
  className?: string;
}

/** Measures the element it is attached to, so the SVG can be drawn in real px. */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => setWidth(el.getBoundingClientRect().width);
    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

const SPARK_PAD_Y = 18;
const SPARK_PAD_START = 14;
/** Room at the end of the plot for the directly-labelled newest point. */
const SPARK_PAD_END = 52;

/**
 * One series, one line, nothing else: no fill, no gridlines, no axis, no
 * legend — the card title names the series. Time runs left → right, and the
 * plot is a dir="ltr" island so the SVG and the HTML overlay share one
 * coordinate frame; the tooltip switches back to RTL for its Arabic text.
 */
export function Sparkline({
  points,
  height = 148,
  formatValue = (value) => String(value),
  emptyTitle = "لا يوجد منحنى بعد",
  emptyHint = "يظهر المنحنى بعد تسجيل درجتين على الأقل.",
  className,
}: SparklineProps) {
  const [ref, width] = useMeasuredWidth();
  const [hovered, setHovered] = useState<number | null>(null);

  // Guard the zero- and one-point cases before any geometry is attempted.
  if (points.length < 2) {
    return <EmptyState title={emptyTitle} hint={emptyHint} />;
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series would divide by zero; give it a band and draw it centred.
  const span = max - min || Math.max(1, Math.abs(max) * 0.1);
  const low = max === min ? min - span / 2 : min;

  const plotWidth = Math.max(0, width - SPARK_PAD_START - SPARK_PAD_END);
  const x = (i: number) => SPARK_PAD_START + (i / (points.length - 1)) * plotWidth;
  const y = (value: number) =>
    height - SPARK_PAD_Y - ((value - low) / span) * (height - SPARK_PAD_Y * 2);

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(p.value)}`).join(" ");
  const lastIndex = points.length - 1;
  const last = points[lastIndex];
  // `hovered` can outlive the point it referred to if `points` shrinks under
  // the cursor, so everything below is derived from the lookup, not the index.
  const active = hovered === null ? undefined : points[hovered];

  const tooltipStyle: CSSProperties =
    hovered === null || active === undefined
      ? {}
      : {
          insetInlineStart: Math.min(Math.max(x(hovered), 72), Math.max(width - 72, 72)),
          top: Math.max(y(active.value) - 14, 4),
        };

  return (
    <div ref={ref} dir="ltr" className={cn("relative w-full", className)} style={{ height }}>
      {width > 0 && (
        <>
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="block overflow-visible"
            role="img"
            aria-label={`منحنى من ${points.length} نقاط`}
          >
            <path
              d={path}
              fill="none"
              stroke="var(--brand)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {points.map((point, i) => (
              <g key={`${point.label}-${i}`}>
                <title>{`${point.label} — ${formatValue(point.value)}${point.hint ? ` · ${point.hint}` : ""}`}</title>
                {/* The visible dot: 8px, 10px for the newest one. */}
                <circle
                  cx={x(i)}
                  cy={y(point.value)}
                  r={i === lastIndex ? 5 : 4}
                  fill="var(--brand)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
                {/* A fat invisible target so a finger can hit it. */}
                <circle
                  cx={x(i)}
                  cy={y(point.value)}
                  r={16}
                  fill="transparent"
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}
                />
              </g>
            ))}
          </svg>

          {/* The newest point, labelled directly — this is why there is no axis. */}
          <span
            className="pointer-events-none absolute -translate-y-1/2 whitespace-nowrap text-sm font-bold text-[var(--ink)]"
            style={{ insetInlineStart: x(lastIndex) + 12, top: y(last.value) }}
          >
            {formatValue(last.value)}
          </span>

          {active && (
            <div
              dir="rtl"
              role="tooltip"
              className="elev pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-start"
              style={tooltipStyle}
            >
              <p className="max-w-44 truncate text-xs font-semibold text-[var(--ink)]">
                {active.label}
              </p>
              <p className="text-sm font-bold text-[var(--brand-ink)]">
                {formatValue(active.value)}
              </p>
              {active.hint !== undefined && (
                <p className="text-xs text-[var(--ink-3)]">{active.hint}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ───────────────────────────── ConfirmButton ──────────────────────────── */

export interface ConfirmButtonProps extends Omit<ButtonProps, "onClick"> {
  onConfirm: () => void;
  /** Label shown while armed. */
  confirmLabel?: ReactNode;
  /** Milliseconds before the armed state reverts. */
  timeoutMs?: number;
}

/**
 * Two-step destructive action: the first click arms the button and swaps its
 * label to «تأكيد الحذف؟»; a second click within `timeoutMs` fires `onConfirm`.
 * Cheaper than a modal for row-level deletes, and impossible to trigger by a
 * stray tap.
 */
export function ConfirmButton({
  onConfirm,
  confirmLabel = "تأكيد الحذف؟",
  timeoutMs = 3500,
  variant = "danger",
  children,
  className,
  ...rest
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [armed, timeoutMs]);

  return (
    <Button
      variant={armed ? "danger" : variant}
      className={cn(armed && "ring-2 ring-[var(--absent-soft)]", className)}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
      {...rest}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}
