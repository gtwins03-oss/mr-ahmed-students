/**
 * set-api-base.mjs — point the Android app at the server's public address.
 *
 *   node scripts/set-api-base.mjs https://mr-ahmed.onrender.com
 *   node scripts/set-api-base.mjs 192.168.1.10:4000     ← back to the LAN
 *   node scripts/set-api-base.mjs --clear               ← same origin as the page
 *
 * or, identically:  npm run set-server -- https://mr-ahmed.onrender.com
 *
 * Rewrites exactly ONE line of web/.env.production — `VITE_API_BASE=…` — and
 * leaves every Arabic comment above it untouched, because those comments are
 * the actual documentation of what the value means (they explain when the line
 * has to change and why an empty value means "same origin").
 *
 * Why this script exists at all: `VITE_API_BASE` is read by Vite at *build*
 * time, so it is baked into the APK. Changing it therefore means editing the
 * file and running `npm run apk` again — and editing an .env file by hand is
 * exactly where a stray `/api`, a missing scheme or an Arabic-Indic digit
 * pasted from a phone silently produces an app that cannot connect.
 *
 * The same normalisation rules as web/src/lib/apiBase.ts are applied here, so
 * the value that lands in the file is the value the app would have derived
 * anyway. Idempotent: re-running with the address already in place reports the
 * no-op and exits 0.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to web/.env.production, whatever the current directory is. */
const ENV_PATH = path.resolve(HERE, "..", "web", ".env.production");

/** The one line this script owns. Anchored per-line, comments never match. */
const ENV_LINE = /^[ \t]*VITE_API_BASE[ \t]*=.*$/m;

/** ٠ ١ ٢ ٣ ٤ ٥ ٦ ٧ ٨ ٩  (U+0660 … U+0669) */
const ARABIC_INDIC = /[٠-٩]/g;
/** ۰ ۱ ۲ ۳ ۴ ۵ ۶ ۷ ۸ ۹  (U+06F0 … U+06F9, Persian/Urdu keyboards) */
const EASTERN_ARABIC = /[۰-۹]/g;

/** Hosts that are legitimately reachable over plain HTTP (no Android block). */
const PRIVATE_HOST =
  /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/i;

/** Words that mean "no baked-in address — use whatever serves the page". */
const CLEAR_WORDS = new Set(["--clear", "-c", "clear", "same-origin", "empty", ""]);

function usage() {
  console.error("");
  console.error("  الاستخدام:");
  console.error("     node scripts/set-api-base.mjs https://mr-ahmed.onrender.com");
  console.error("     node scripts/set-api-base.mjs 192.168.1.10:4000");
  console.error("     node scripts/set-api-base.mjs --clear");
  console.error("");
}

function fail(message) {
  console.error("");
  console.error(`  ❌ ${message}`);
  usage();
  process.exit(1);
}

/**
 * "١٩٢.168.1.10:4000/api/" → "http://192.168.1.10:4000"
 * "MR-Ahmed.OnRender.com/" → "https://mr-ahmed.onrender.com"
 *
 * Returns the cleaned address plus the list of fixes applied, so the teacher
 * sees what was changed about what he typed instead of a silent correction.
 */
function normalise(raw) {
  const notes = [];

  let url = String(raw)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EASTERN_ARABIC, (d) => String(d.charCodeAt(0) - 0x06f0));

  if (url !== String(raw).trim()) notes.push("تم تحويل الأرقام العربية والاقتباسات.");

  // No scheme: guess the one that actually works for that host — plain HTTP is
  // fine on the LAN, and Android refuses it on a public domain.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const host = url.split("/")[0]?.split(":")[0] ?? "";
    const scheme = PRIVATE_HOST.test(host) ? "http" : "https";
    url = `${scheme}://${url}`;
    notes.push(`لم يكن هناك بروتوكول، فتمت إضافة ‎${scheme}://‎.`);
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`العنوان غير صالح: "${raw}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(`البروتوكول غير مدعوم: "${parsed.protocol}" — المسموح http أو https فقط.`);
  }
  if (!parsed.hostname) fail(`العنوان لا يحتوي على اسم خادم: "${raw}"`);
  if (parsed.username || parsed.password) {
    fail("لا تضع اسم مستخدم أو كلمة مرور داخل العنوان.");
  }
  if (parsed.search || parsed.hash) {
    notes.push("تم حذف ما بعد علامة ‎?‎ أو ‎#‎ — العنوان يجب أن ينتهي عند اسم الخادم.");
  }

  // The base NEVER carries the "/api" prefix; apiUrl() adds it. A pasted
  // ".../api" would otherwise produce ".../api/api/students".
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (/\/api$/i.test(pathname)) {
    notes.push("تم حذف ‎/api‎ من آخر العنوان — التطبيق يضيفها بنفسه.");
  } else if (pathname !== "") {
    fail(
      `العنوان يجب أن ينتهي عند اسم الخادم، بدون مسار إضافي: "${parsed.origin}${pathname}"`,
    );
  }

  const clean = parsed.origin;

  if (parsed.protocol === "http:" && !PRIVATE_HOST.test(parsed.hostname)) {
    console.warn("");
    console.warn("  ⚠️  تحذير: عنوان عام على http بدون تشفير.");
    console.warn("     أندرويد ٩ فما فوق يمنع الاتصال غير المشفّر بالنطاقات العامة،");
    console.warn("     فالتطبيق على الموبايل لن يتصل بهذا العنوان. استخدم https.");
  }

  return { url: clean, notes };
}

function main() {
  const argument = process.argv[2];

  if (argument === undefined) fail("لم يتم تحديد عنوان الخادم.");
  if (argument === "--help" || argument === "-h") {
    usage();
    process.exit(0);
  }

  const clearing = CLEAR_WORDS.has(argument.trim().toLowerCase());
  const { url: next, notes } = clearing ? { url: "", notes: [] } : normalise(argument);

  if (!fs.existsSync(ENV_PATH)) fail(`لم يتم العثور على الملف: ${ENV_PATH}`);

  const original = fs.readFileSync(ENV_PATH, "utf8");
  const match = original.match(ENV_LINE);
  const before = match ? match[0].trim() : "(السطر غير موجود)";
  const after = `VITE_API_BASE="${next}"`;

  console.log("");
  console.log(`  📄 الملف:     ${ENV_PATH}`);
  console.log(`  ⬅️  قبل:      ${before}`);

  for (const note of notes) console.log(`  ✏️  ${note}`);

  if (before === after) {
    console.log(`  ➡️  بعد:      ${after}  (لا تغيير — العنوان مضبوط بالفعل)`);
    console.log("");
    return;
  }

  // Replace, never rewrite: `$&`-style patterns in the URL must stay literal,
  // and every Arabic comment in the file has to survive untouched.
  let updated;
  if (match) {
    updated = original.replace(ENV_LINE, () => after);
  } else {
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const body = original.endsWith(eol) || original === "" ? original : original + eol;
    updated = `${body}${after}${eol}`;
    console.log("  ✏️  لم يكن السطر موجوداً، فتمت إضافته في آخر الملف.");
  }

  fs.writeFileSync(ENV_PATH, updated, "utf8");

  console.log(`  ➡️  بعد:      ${after}`);
  console.log("");

  if (clearing) {
    console.log("  ℹ️  العنوان أصبح فارغاً: التطبيق سيسأل عن عنوان الخادم عند أول");
    console.log("     تشغيل من شاشة «إعداد الخادم»، والمتصفح سيستخدم عنوان الصفحة نفسها.");
  } else {
    console.log(`  ℹ️  تأكد أولاً أن ${next}/api/health يرد ‎{"ok":true}‎.`);
  }

  console.log("");
  console.log("  📱 الخطوة التالية — أعد بناء التطبيق ليأخذ العنوان الجديد:");
  console.log("       npm run apk");
  console.log("     ثم ثبّت StudentApp.apk فوق القديم على التليفون (لن تفقد شيئاً).");
  console.log("");
  console.log("     الواجهة في المتصفح لا تحتاج أي خطوة — هي تقرأ العنوان من الصفحة نفسها.");
  console.log("");
}

main();
