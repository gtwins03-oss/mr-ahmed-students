/**
 * The template engine: `{{placeholder}}` substitution plus Arabic date/time helpers.
 *
 * Placeholder contract — an unknown `{{key}}` renders as an empty string instead of
 * throwing, so a typo in a teacher-edited template degrades gracefully rather than
 * blocking a send. Every formatter is defensive too: given garbage it returns the raw
 * input, never the string "Invalid Date" (which would be shipped straight to a parent).
 */

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;
const HHMM = /^(\d{1,2}):(\d{2})/;

/** Intl formatters are expensive to build — one instance per shape, reused. */
const dateFmt = new Intl.DateTimeFormat("ar-EG", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const monthFmt = new Intl.DateTimeFormat("ar-EG", { month: "long", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("ar-EG", { hour: "numeric", minute: "2-digit" });

/** Replace every `{{key}}` with `vars[key]`; missing/null values become "". */
export function render(tpl: string, vars: Record<string, unknown> = {}): string {
  if (typeof tpl !== "string" || tpl.length === 0) return "";
  const source = vars ?? {};
  return tpl.replace(PLACEHOLDER, (_match: string, key: string) => {
    const v = source[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** "2026-09-05" → "السبت ٥ سبتمبر ٢٠٢٦"  (unparseable input is returned untouched) */
export function arDate(isoDate: string): string {
  const raw = String(isoDate ?? "").trim();
  if (!raw) return "";
  const key = raw.slice(0, 10);
  const d = ISO_DATE.test(key) ? new Date(`${key}T00:00:00`) : new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  try {
    return dateFmt.format(d);
  } catch {
    return raw;
  }
}

/** "2026-09" → "سبتمبر ٢٠٢٦"  (also accepts a full "2026-09-05") */
export function arMonth(ym: string): string {
  const raw = String(ym ?? "").trim();
  if (!raw) return "";
  const key = raw.slice(0, 7);
  const d = ISO_MONTH.test(key) ? new Date(`${key}-01T00:00:00`) : new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  try {
    return monthFmt.format(d);
  } catch {
    return raw;
  }
}

/** "16:00" → "٤:٠٠ م"  (unparseable input is returned untouched) */
export function arTime(hhmm: string): string {
  const raw = String(hhmm ?? "").trim();
  if (!raw) return "";
  const m = HHMM.exec(raw);
  if (!m) return raw;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return raw;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return raw;
  try {
    return timeFmt.format(new Date(2000, 0, 1, hours, minutes));
  } catch {
    return raw;
  }
}
