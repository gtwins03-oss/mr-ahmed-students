/**
 * Phone normalisation — E.164, Arabic-Indic digits included.
 *
 * Parents type numbers as "01001234567", "0100 123 4567", "+20 100 123 4567",
 * "0020100…" or in Arabic-Indic digits "٠١٠٠١٢٣٤٥٦٧". WhatsApp needs exactly one
 * canonical form, so we normalise **on write** and never on read: everything in the
 * database is already "+201001234567".
 */

/** ٠ ١ ٢ ٣ ٤ ٥ ٦ ٧ ٨ ٩  (U+0660 … U+0669) */
const ARABIC_INDIC = /[٠-٩]/g;
/** ۰ ۱ ۲ ۳ ۴ ۵ ۶ ۷ ۸ ۹  (U+06F0 … U+06F9, Persian/Urdu keyboards) */
const EASTERN_ARABIC = /[۰-۹]/g;

/** Fallback when no country code is configured in Settings. */
export const DEFAULT_COUNTRY_CODE = "+20";

/**
 * "٠١٠٠١٢٣٤٥٦٧" | "0100 123 4567" | "0020100…" → "+201001234567"
 *
 * Anything already starting with "+" is trusted as-is; a leading "00" becomes "+";
 * otherwise the leading zeros are dropped and the default country code prefixed.
 */
export function toE164(raw: string, defaultCountryCode = DEFAULT_COUNTRY_CODE): string {
  const ascii = String(raw ?? "")
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EASTERN_ARABIC, (d) => String(d.charCodeAt(0) - 0x06f0));

  let s = ascii.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("+")) return s;

  const cc = String(defaultCountryCode || DEFAULT_COUNTRY_CODE).trim();
  const prefix = cc.startsWith("+") ? cc : `+${cc.replace(/\D/g, "")}`;
  return prefix + s.replace(/^0+/, "");
}

/** A plausible international number: "+" then 8–15 digits, never starting with 0. */
export function isValidE164(s: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(String(s ?? ""));
}

/** Green API / WhatsApp Web chat id — digits only, no "+". */
export const toChatId = (e164: string): string => `${String(e164 ?? "").replace(/\D/g, "")}@c.us`;

/** Tier 0 click-to-chat link. Note: no "+" in the path, body is percent-encoded. */
export const toWaLink = (e164: string, body: string): string =>
  `https://wa.me/${String(e164 ?? "").replace(/\D/g, "")}?text=${encodeURIComponent(String(body ?? ""))}`;
