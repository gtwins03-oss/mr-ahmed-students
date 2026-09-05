/**
 * Where the API lives.
 *
 * In the browser the answer is boring: nothing, because Vite proxies `/api` to
 * http://localhost:4000 in development and Express serves the built SPA itself
 * in production, so a relative path works in both.
 *
 * Inside the Android APK there is no dev proxy and no same-origin server — the
 * WebView is served from `capacitor://localhost` — so the teacher has to point
 * the app at the machine running the server ("http://192.168.1.10:4000").
 * That address is stored in localStorage and edited on the «إعداد الخادم»
 * screen (src/pages/ServerSetup.tsx).
 *
 * Resolution order, first non-empty wins:
 *   1. localStorage "tutor.apiBase"   — what the teacher typed on this device
 *   2. import.meta.env.VITE_API_BASE  — baked in at build time (APK builds)
 *   3. ""                             — same origin, i.e. the /api proxy
 *
 * The base NEVER contains the "/api" prefix; `apiUrl()` adds it. That keeps a
 * pasted "http://host:4000/api" working instead of producing "/api/api/…".
 */

/** localStorage key holding the server address chosen on this device. */
export const API_BASE_STORAGE_KEY = "tutor.apiBase";

/** Every route on the server is mounted under this prefix. */
export const API_PREFIX = "/api";

/** ٠ ١ ٢ ٣ ٤ ٥ ٦ ٧ ٨ ٩  (U+0660 … U+0669) */
const ARABIC_INDIC = /[٠-٩]/g;
/** ۰ ۱ ۲ ۳ ۴ ۵ ۶ ۷ ۸ ۹  (U+06F0 … U+06F9, Persian/Urdu keyboards) */
const EASTERN_ARABIC = /[۰-۹]/g;

/**
 * A WebView with storage disabled throws on `localStorage` access instead of
 * returning null, and that must never take the whole app down.
 */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the address simply will not survive a restart */
  }
}

/**
 * "١٩٢.168.1.10:4000/api/" → "http://192.168.1.10:4000"
 *
 * Tolerates what a hurried teacher actually types on a phone: Arabic-Indic
 * digits, a missing scheme, a trailing slash, and a pasted "/api" suffix.
 * An empty string means "same origin" and is returned untouched.
 */
export function normaliseApiBase(raw: string): string {
  let url = String(raw ?? "")
    .trim()
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EASTERN_ARABIC, (d) => String(d.charCodeAt(0) - 0x06f0));

  if (url === "") return "";
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;

  return url
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "")
    .replace(/\/+$/, "");
}

/** The server address in use right now — "" means the same-origin /api proxy. */
export function getApiBase(): string {
  const stored = readStored(API_BASE_STORAGE_KEY);
  if (stored !== null && stored.trim() !== "") return normaliseApiBase(stored);

  const fromEnv = import.meta.env.VITE_API_BASE;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return normaliseApiBase(fromEnv);

  return "";
}

/** Stores a new server address; an empty string clears it back to same-origin. */
export function setApiBase(url: string): void {
  const next = normaliseApiBase(url);
  writeStored(API_BASE_STORAGE_KEY, next === "" ? null : next);
}

/** True once an explicit address has been chosen (or baked in at build time). */
export function isApiBaseConfigured(): boolean {
  return getApiBase() !== "";
}

/**
 * Full URL for an API path: `apiUrl("/students")` → "/api/students" in the
 * browser, "http://192.168.1.10:4000/api/students" in the APK. Pass `base`
 * explicitly to probe a candidate address before saving it.
 */
export function apiUrl(path: string, base: string = getApiBase()): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${API_PREFIX}${suffix}`;
}

/** Origin the realtime socket should dial — never a relative string. */
export function getSocketUrl(): string {
  return getApiBase() || window.location.origin;
}

/**
 * True when running inside the Capacitor Android shell rather than a browser
 * tab. Used to decide whether a missing server address is fatal: in a browser
 * "" is a perfectly good base, in the APK it points at the WebView itself.
 */
export function isNativeApp(): boolean {
  const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor;
  try {
    return typeof capacitor?.isNativePlatform === "function"
      ? Boolean(capacitor.isNativePlatform())
      : false;
  } catch {
    return false;
  }
}
