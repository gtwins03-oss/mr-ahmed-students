# Mr Ahmed Ibrahim Students — مستر أحمد إبراهيم — إدارة الطلاب

**Mr Ahmed Ibrahim Students** is a single-tutor system for managing students, classes,
attendance, grades, and automated Arabic WhatsApp/SMS alerts to parents. Arabic RTL
front-end, JWT auth, two roles (OWNER / ASSISTANT), full audit trail, and an Android
APK wrapper.

## التشغيل السريع

المطلوب **Node.js 20 أو أحدث** وبس — قاعدة البيانات ملف SQLite واحد، مفيش سيرفر قواعد بيانات تنصّبه.

من جذر المشروع، في PowerShell:

```powershell
cd "d:\programming\mr ahmed"
npm install                                                          # أدوات الجذر (concurrently)
if (-not (Test-Path server\.env)) { Copy-Item server\.env.example server\.env }
npm run setup                                                        # حزم الخادم والواجهة + قاعدة البيانات + بيانات تجريبية
npm run dev                                                          # الـ API على ٤٠٠٠ والواجهة على ٥١٧٣
```

بعدين افتح **<http://localhost:5173>** وسجّل دخول بـ `ahmed` / `admin123`.

> ⚠️ **غيّر كلمة المرور دي فوراً** من **الإعدادات ← الحساب**. `admin123` قيمة افتراضية معروفة،
> وأي حد على نفس شبكة الواي فاي يقدر يدخل بيها على بيانات طلابك وأرقام أولياء أمورهم.
> ولو هتنشر النظام على الإنترنت، غيّر كمان `JWT_SECRET` في `server/.env` لنص عشوائي طويل.

على ويندوز تقدر تتخطّى ده كله وتعمل دبل كليك على **`start.bat`** — بينصّب أول مرة وبيشغّل كل مرة بعدها.
(بس نفّذ سطر نسخ `.env` مرة واحدة قبله.)

**التشغيل اليومي بعد كده:** `npm run dev` وبس.

**أوامر تانية شائعة:**

| الأمر | إيه اللي بيعمله |
|---|---|
| `npm run db:reset` | يزبّط الجداول ويضيف الناقص من القوالب والبيانات التجريبية (مش بيمسح بياناتك) |
| `npm run build` | يبني نسخة الإنتاج: `web/dist` + `server/dist` |
| `npm start` | يشغّل نسخة الإنتاج المبنية (الخادم بيقدّم الواجهة كمان على المنفذ ٤٠٠٠) |
| `npm run apk` | يبني `StudentApp.apk` (محتاج JDK 17 + Android SDK) |
| `npm run --prefix server db:studio` | Prisma Studio لتصفّح قاعدة البيانات على <http://localhost:5555> |

الشرح الكامل، والجولة التجريبية، وإعداد Green API، والنسخ الاحتياطي، وحل المشاكل:
**[docs/04-التشغيل.md](docs/04-التشغيل.md)**.

## Documents

| File | Contents |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | Messaging-tier decision, tech stack, component diagram, folder layout, REST API surface |
| [docs/02-messaging.md](docs/02-messaging.md) | Provider adapters (wa.me / Green API / Twilio), phone normalisation, template engine, Arabic templates, outbox, alert triggers |
| [docs/03-roadmap.md](docs/03-roadmap.md) | Nine phases, ~10 days, each ending in a usable increment |
| [docs/04-التشغيل.md](docs/04-التشغيل.md) | **دليل التشغيل بالعربي** — المتطلبات، التشغيل المحلي، جولة ٥ دقايق، المستخدمون والصلاحيات، سجل النشاط، الشبكة الضعيفة، كل أوامر npm، حل المشاكل |
| [docs/05-النشر-والموبايل.md](docs/05-النشر-والموبايل.md) | **دليل النشر بالعربي** — Supabase/PostgreSQL، نشر الخادم على Render/Railway/Fly، بناء الـ APK محلياً أو على GitHub Actions، أول تشغيل على التليفون، التحديث، توقيع نسخة الإصدار، الأمان |
| [server/prisma/schema.prisma](server/prisma/schema.prisma) | The data model — SQLite today, one-line switch to PostgreSQL |
| [server/prisma/seed.ts](server/prisma/seed.ts) | Idempotent seed: settings, the four Arabic templates, the OWNER account, demo data |
| [db/schema.sql](db/schema.sql) | Equivalent raw DDL with CHECK constraints |

## The short version

- **Stack:** React 18 + Vite + TypeScript + Tailwind v4 (RTL) · Node + Express + TypeScript ·
  Prisma · SQLite · Socket.IO · Capacitor 6 for the Android shell
- **Hosting:** one always-on process — the tutor's PC, or a free tier on Render/Railway/Fly.
  *Not* serverless: the same process hosts the API, the cron jobs and the outbox dispatcher.
- **Auth:** JWT Bearer tokens (not cookies — the app runs inside an Android WebView).
  Two roles: OWNER does everything; ASSISTANT does everything **with the data** and is simply
  never shown `/api/users` or `/api/audit`.
- **Messaging:** starts free with `wa.me` 1-click links; flip one setting to Green API for
  full automation. Both paths reuse the same outbox, templates, and triggers.
- **Core loop:** mark absent → alert queued → parent notified, in one tap.

## Key design decisions

1. **Outbox pattern.** Every notification is a row in `messages` before it is a send.
   Gives you history, retries, previews, and provider-swapping for free.
2. **`dedupeKey` uniqueness.** `ABSENT:{sessionId}:{studentId}` for attendance,
   `LOW_GRADE:{assessmentId}:{studentId}` for grades — re-saving a grid can never
   double-message a parent.
3. **Dates as `TEXT`, not timestamps.** A 4pm class is at 4pm; storing UTC for schedules
   causes off-by-one-day bugs.
4. **Soft-delete students.** Preserves a year of attendance history.
5. **Services own the rules.** Routes never build messages; "mark absent" and "notify parent"
   live in one testable function.
6. **Provider-agnostic schema.** String status columns (never native enums), no arrays, no
   Postgres-only types — so `db:use-postgres` is a one-line switch, not a migration project.
7. **Audit log is append-only and owner-only.** No POST/PATCH/DELETE on `/api/audit`;
   secrets are redacted before a snapshot is written.
