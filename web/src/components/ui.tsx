/**
 * Every UI primitive in the app lives in this one file.
 *
 * Design rules baked in here:
 *  - RTL only. Spacing and positioning use logical properties (ps/pe, ms/me,
 *    start/end) so nothing has to be mirrored by hand.
 *  - Generous tap targets. This is operated mid-class, one-handed, in a hurry.
 *  - Slate/blue base; emerald = present, rose = absent, amber = late.
 *  - Dependency-free apart from react and lucide-react.
 *
 * Every primitive forwards its remaining props to the underlying element and
 * merges an optional `className`, so callers can specialise without wrapping.
 */

import {
  forwardRef,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
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
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white";

/* ──────────────────────────────── Button ──────────────────────────────── */

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-blue-600 text-white shadow-sm hover:bg-blue-700 active:bg-blue-800",
  secondary:
    "border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-50 active:bg-slate-100",
  danger: "bg-rose-600 text-white shadow-sm hover:bg-rose-700 active:bg-rose-800",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-9 gap-1.5 px-3 text-sm",
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
        "inline-flex select-none items-center justify-center rounded-xl font-semibold transition-colors",
        "disabled:pointer-events-none disabled:opacity-50",
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
  /** Extra classes for the body wrapper, e.g. "p-0" free tables. */
  bodyClassName?: string;
  children?: ReactNode;
}

export function Card({ title, actions, className, bodyClassName, children }: CardProps) {
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm",
        className,
      )}
    >
      {hasHeader && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          {title !== undefined && (
            <h2 className="text-start text-base font-bold text-slate-800">{title}</h2>
          )}
          {actions !== undefined && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

/* ────────────────────────────── Form fields ───────────────────────────── */

const FIELD_BASE =
  "block w-full rounded-xl border bg-white px-3 py-2.5 text-start text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500";

const FIELD_OK = "border-slate-300 focus:border-blue-500 focus:ring-blue-500/30";
const FIELD_ERROR = "border-rose-400 focus:border-rose-500 focus:ring-rose-500/30";

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-start text-sm font-semibold text-slate-700"
    >
      {children}
    </label>
  );
}

function FieldError({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-start text-xs font-medium text-rose-600">{children}</p>;
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
          className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        />
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
});

/* ──────────────────────────────── Badge ───────────────────────────────── */

export type BadgeTone = "green" | "red" | "amber" | "blue" | "gray";

const BADGE_TONES: Record<BadgeTone, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  red: "bg-rose-50 text-rose-700 ring-rose-200",
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
  blue: "bg-blue-50 text-blue-700 ring-blue-200",
  gray: "bg-slate-100 text-slate-600 ring-slate-200",
};

export interface BadgeProps {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = "gray", className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
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
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl",
          className,
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <h2 className="text-start text-base font-bold text-slate-800">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className={cn(
              "-me-1 rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700",
              FOCUS_RING,
            )}
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">{children}</div>

        {footer !== undefined && (
          <footer className="flex flex-wrap items-center justify-start gap-2 border-t border-slate-100 px-4 py-3">
            {footer}
          </footer>
        )}
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
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {icon !== undefined && (
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
          {icon}
        </div>
      )}
      <p className="text-base font-bold text-slate-700">{title}</p>
      {hint !== undefined && (
        <p className="max-w-sm text-sm leading-6 text-slate-500">{hint}</p>
      )}
      {action !== undefined && <div className="mt-1">{action}</div>}
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
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-start text-xl font-bold text-slate-900 sm:text-2xl">{title}</h1>
        {subtitle !== undefined && (
          <p className="mt-1 text-start text-sm text-slate-500">{subtitle}</p>
        )}
      </div>
      {actions !== undefined && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/* ─────────────────────────────── Spinner ──────────────────────────────── */

export function Spinner({ className }: { className?: string }) {
  return (
    <span role="status" aria-label="جارٍ التحميل" className="inline-flex">
      <Loader2 className={cn("h-5 w-5 animate-spin text-blue-600", className)} />
    </span>
  );
}

/** Centred spinner for a whole panel that is still loading. */
export function LoadingBlock({ label = "جارٍ التحميل…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-sm text-slate-500">
      <Spinner />
      <span>{label}</span>
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
      className={cn(armed && "animate-pulse", className)}
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
