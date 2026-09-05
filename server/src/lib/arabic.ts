/**
 * Arabic-Indic digits for text a human reads.
 *
 * The audit trail is written in Arabic sentences («سجّل درجة "يوسف علي": ٤٥ من
 * ١٠٠»), so any number spliced into one of those sentences goes through `arNum`
 * rather than being interpolated straight. Dates and times already have their
 * own formatters in `messaging/template.ts` — this file is only about numbers.
 *
 * Defensive like the template helpers: given something unformattable it returns
 * the raw text instead of "NaN", which would otherwise end up in the log.
 */

const NUMBER_FORMAT = new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 2 });

/** 45 → "٤٥"  ·  87.5 → "٨٧٫٥"  ·  "" → "" */
export function arNum(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return String(value);
  try {
    return NUMBER_FORMAT.format(n);
  } catch {
    return String(value);
  }
}

/** 60 → "٦٠٪" */
export const arPercent = (value: number | string | null | undefined): string =>
  `${arNum(value)}٪`;

/** Wraps a name in quotes the way every audit sentence does: «"أحمد سمير"». */
export const arQuote = (text: string | null | undefined): string => `"${text ?? ""}"`;

/**
 * Class names are usually prose already ("مجموعة السبت - ٣ ثانوي"), so a
 * sentence reads best with them bare: «أضافه إلى مجموعة السبت». Anything not
 * starting with "مجموعة" gets the word prefixed and the name quoted.
 */
export const arClass = (name: string | null | undefined): string => {
  const text = (name ?? "").trim();
  if (!text) return "المجموعة";
  return text.startsWith("مجموعة") ? text : `مجموعة "${text}"`;
};

/**
 * Arabic counts read badly with a bare plural ("٢ طالب"), so the common shapes
 * get their own agreement: ١ طالب · طالبان · ٣ طلاب · ١١ طالباً.
 */
export function arCount(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n % 100 >= 3 && n % 100 <= 10) return `${arNum(n)} ${few}`;
  return `${arNum(n)} ${many}`;
}

/** "٣ طلاب" / "طالبان" / "١٥ طالباً" */
export const arStudents = (n: number): string =>
  arCount(n, "طالب واحد", "طالبان", "طلاب", "طالباً");

/** "٣ حصص" / "حصتان" / "١٥ حصة" */
export const arSessions = (n: number): string =>
  arCount(n, "حصة واحدة", "حصتان", "حصص", "حصة");

/** "٣ رسائل" / "رسالتان" / "١٥ رسالة" */
export const arMessages = (n: number): string =>
  arCount(n, "رسالة واحدة", "رسالتان", "رسائل", "رسالة");
