# 3 — Step-by-step development plan

Ten working phases. Each ends with something the teacher can actually use, so the tool is
never "half-built and unusable". Estimates assume one developer.

---

## Phase 0 — Scaffold (½ day)

```bash
# repo root
mkdir server web && cd server
npm init -y
npm i express cors zod @prisma/client node-cron dotenv express-session
npm i -D typescript tsx @types/express @types/node @types/cors prisma
npx tsc --init
npx prisma init --datasource-provider sqlite
# set DATABASE_URL="file:../data/tutor.db" in server/.env

cd ../web
npm create vite@latest . -- --template react-ts
npm i @tanstack/react-query axios date-fns lucide-react
npm i -D tailwindcss @tailwindcss/vite
```

Copy `prisma/schema.prisma` (already written) into place, then:

```bash
cd server && npx prisma migrate dev --name init && npx prisma generate
```

RTL setup — `web/index.html`:
```html
<html lang="ar" dir="rtl">
```
and load an Arabic UI font (Cairo / IBM Plex Sans Arabic / Tajawal). Use Tailwind's logical
utilities (`ps-4`, `pe-4`, `ms-auto`) instead of `pl-`/`pr-` so nothing breaks in RTL.

**Done when:** `GET /api/health` returns `{ok:true}` and the Vite dev server proxies `/api`.

---

## Phase 1 — Students & classes (1½ days)

- `students` CRUD with Zod validation; normalise the phone with `toE164()` **on write**.
- `class_groups` CRUD + `schedule_slots` editor (weekday × start/end time).
- Enrolment: a checkbox list of students on the class page.
- Students list: search by name/phone, filter by class and grade level.

**Watch for:** duplicate parent phones across siblings — allow it, but show a warning badge
so the teacher knows two students share one number.

**Done when:** the teacher can enter their real roster and see each class with its students.

---

## Phase 2 — Sessions from the schedule (½ day)

`POST /api/sessions/ensure?date=YYYY-MM-DD` reads every `ScheduleSlot` whose `weekday`
matches and upserts a `Session`. The `@@unique([classGroupId, date, startTime])` constraint
makes it safe to call repeatedly. A 06:00 cron calls it for today; the UI also calls it when
the teacher opens a past date.

```ts
export async function ensureSessions(date: string) {
  const weekday = new Date(`${date}T00:00:00`).getDay(); // 0 = Sunday
  const slots = await prisma.scheduleSlot.findMany({
    where: { weekday, classGroup: { isActive: true } },
  });
  await Promise.all(slots.map((s) =>
    prisma.session.upsert({
      where: { classGroupId_date_startTime: {
        classGroupId: s.classGroupId, date, startTime: s.startTime } },
      update: {},
      create: { classGroupId: s.classGroupId, date,
                startTime: s.startTime, endTime: s.endTime, status: "HELD" },
    }),
  ));
  return slots.length;
}
```

**Done when:** opening the app on a Saturday shows Saturday's classes with no manual setup.

---

## Phase 3 — Attendance board (1 day)

The screen the teacher uses every single day. Optimise it ruthlessly.

- Big date picker defaulting to today; one card per session.
- One row per student, three large buttons: **حاضر / غائب / متأخر**.
- Tapping a button marks *and* commits optimistically (TanStack Query mutation).
- "تحديد الكل حاضر" bulk button — the common case is everyone present with 1–2 absences.
- Running counter: `حاضر ١٢ · غائب ٢ · متأخر ١`.

```tsx
// web/src/components/AttendanceRow.tsx
const OPTIONS = [
  { value: "PRESENT", label: "حاضر",  cls: "bg-emerald-600" },
  { value: "ABSENT",  label: "غائب",  cls: "bg-rose-600" },
  { value: "LATE",    label: "متأخر", cls: "bg-amber-500" },
] as const;

export function AttendanceRow({ student, status, onMark }) {
  return (
    <div className="flex items-center gap-3 border-b py-3">
      <div className="flex-1">
        <p className="font-semibold">{student.name}</p>
        <p className="text-sm text-gray-500">{student.parentName}</p>
      </div>
      <div className="flex gap-2">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => onMark(student.id, o.value)}
            className={`min-w-20 rounded-lg px-4 py-2 text-sm font-medium transition
              ${status === o.value ? `${o.cls} text-white` : "bg-gray-100 text-gray-700"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

**Done when:** a 15-student class can be marked in under 20 seconds, and absences appear in
the Send Queue immediately.

---

## Phase 4 — Grades (1 day)

- Create an assessment: class, title, type, `maxScore`, date.
- Score-entry grid: one number input per enrolled student, Enter jumps to the next row.
- Live percentage badge beside each input, red below the threshold.
- Blank = did not sit the test (`score = null`) — excluded from averages, no alert.
- Student detail page: score history + a simple trend line.

**Done when:** entering a 40/100 shows a red badge and queues a `LOW_GRADE` message.

---

## Phase 5 — Messaging core, Tier 0 (1½ days)

- Seed the four Arabic templates + the settings row (`prisma/seed.ts`).
- `enqueueMessage`, the template renderer, `toE164`, `toWaLink`.
- **Send Queue page** — the Tier 0 workhorse:
  - list of `PENDING` messages, grouped by student, each showing the full Arabic body;
  - **«فتح واتساب»** button → `window.open(toWaLink(phone, body))`;
  - **«تم الإرسال ✓»** → `POST /api/messages/:id/mark-sent`;
  - **«إرسال الكل»** → opens each link sequentially with a short delay;
  - edit-before-send, and a **«تجاهل»** (skip) action.
- Templates editor in Settings with a live preview using a sample student.

**Done when:** marking a student absent → opening Send Queue → two taps → the parent has the
Arabic message. No API keys involved.

---

## Phase 6 — Automation, Tier 1 (1 day)

- Settings screen: provider selector + credential fields + **«اختبار الإرسال»** test button.
- `greenApiProvider`, `resolveProvider(settings)`, `drainOutbox()`, quiet-hours guard.
- `node-cron`: `*/2 * * * *` → `drainOutbox()`.
- Message history page: status chips (`SENT` / `FAILED` / `PENDING`), error text, retry button.

**Done when:** flipping the provider to `GREEN_API` makes the same messages send themselves,
with zero changes to attendance or grade code.

---

## Phase 7 — Reports (1 day)

Aggregation per student over a date range:

```ts
export async function studentReport(studentId: string, from: string, to: string) {
  const [attendance, grades] = await Promise.all([
    prisma.attendance.findMany({
      where: { studentId, session: { date: { gte: from, lte: to } } },
    }),
    prisma.grade.findMany({
      where: { studentId, score: { not: null },
               assessment: { date: { gte: from, lte: to } } },
      include: { assessment: true },
    }),
  ]);

  const count = (s: string) => attendance.filter((a) => a.status === s).length;
  const total = attendance.length;
  const pcts = grades.map((g) => (g.score! / g.assessment.maxScore) * 100);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  return {
    sessions_total: total,
    present_count: count("PRESENT"),
    absent_count: count("ABSENT"),
    late_count: count("LATE"),
    attendance_rate: total ? Math.round(((count("PRESENT") + count("LATE")) / total) * 100) : 0,
    assessments_count: pcts.length,
    average_percentage: avg(pcts).toFixed(1),
    best_percentage: pcts.length ? Math.max(...pcts).toFixed(1) : "—",
    worst_percentage: pcts.length ? Math.min(...pcts).toFixed(1) : "—",
  };
}
```

- `POST /api/reports/monthly/queue?month=2026-09` enqueues a `MONTHLY_REPORT` for every
  active student (`dedupeKey: REPORT:2026-09:{studentId}`).
- Cron `0 18 1 * *` — 1st of the month, 6pm — queues them automatically.
- Dashboard: today's sessions, attendance rate this week, students below threshold,
  chronic absentees (3+ absences this month).

**Done when:** one click produces a personalised Arabic report for the whole roster.

---

## Phase 8 — Hardening & deploy (1 day)

- Password login (`express-session`, one bcrypt hash in `.env`).
- Nightly SQLite backup: `fs.copyFile()` → `backups/tutor-YYYY-MM-DD.db`, keep 30.
- CSV export of students / attendance / grades — the teacher's escape hatch.
- Deploy, either:
  - **Local:** `npm run build` both apps, serve `web/dist` from Express, add a Windows
    Startup shortcut to `node server/dist/index.js`; or
  - **Cloud:** Railway/Render with a persistent volume for `data/tutor.db`.
- Rate-limit `/api/messages/*`, and validate every body with Zod.

**Done when:** the teacher opens one icon and everything works, including after a reboot.

---

## Total: ~9–10 working days to a production tool

### Deliberately out of scope for v1

Fee/payment tracking, homework assignments, a parent-facing portal, multi-teacher accounts,
and a mobile app. Each is a real feature — add them once the daily attendance-and-alerts
loop is proven in actual use. The fastest way to fail here is to build eight modules the
teacher never opens instead of one they use every day.

### Suggested build order if you must compress

Phases 0 → 1 → 3 → 5 gets a working absence-alert system in ~4 days. Grades (4) and reports
(7) can follow after the teacher is already using it daily.
