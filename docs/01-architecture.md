# 1 — System Architecture

## 1.1 The decision that shapes everything: how WhatsApp gets sent

Before picking a framework, pick a messaging tier. This choice decides your hosting model,
your monthly cost, and how much of the system can run unattended.

| Tier | Provider | Automation | Cost | Ban risk | Setup time | Needs always-on server? |
|---|---|---|---|---|---|---|
| **0. `wa.me` deep link** | WhatsApp click-to-chat | 1-click (teacher taps Send) | Free | None | 0 min | No |
| **1. Green API** | Unofficial gateway on *your own* number | Fully automatic | ~$0–14/mo | Medium | ~15 min | Yes |
| **2. Twilio / Meta Cloud API** | Official WhatsApp Business API | Fully automatic | Per message | None | Days (business verification + template approval) | Yes |
| **SMS fallback** | Twilio / local aggregator | Fully automatic | Per message | None | ~30 min | Yes |

**Recommendation: build on Tier 0, design for Tier 1.**
A private tutor sending 10–40 messages a day does not need a paid API on day one. `wa.me`
links cost nothing, cannot get the number banned, and require zero approval — the teacher
taps a green button and WhatsApp opens with the Arabic message already typed. When volume
grows, flipping a single setting to `GREEN_API` makes the exact same messages send themselves.

This is only possible because of the **outbox pattern** (§1.3). Every alert is written to a
`messages` table as `PENDING` regardless of tier. What differs is *who drains the queue*:
the teacher's thumb, or a background dispatcher.

## 1.2 Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | **React 18 + Vite + TypeScript + TailwindCSS** | Fastest dev loop; first-class RTL; no SSR complexity needed for a single-user tool |
| UI kit | **shadcn/ui** (Radix + Tailwind) | Copy-in components, no runtime dep, easy to force `dir="rtl"` |
| Server state | **TanStack Query** | Free optimistic updates — critical for the one-click attendance grid |
| Backend | **Node.js 24 + Express + TypeScript** | Same language both sides; one process hosts API + cron + WhatsApp worker |
| ORM | **Prisma** | One schema file → SQLite locally, Postgres in the cloud, by changing one line |
| Database | **SQLite** (file) → **Postgres/Supabase** if multi-device | Zero-admin, single file, trivially backed up to a `.db` copy |
| Scheduler | **node-cron** in-process | Monthly reports, session auto-creation, outbox retries |
| Deploy | Tutor's own PC (`npm start`) **or** Railway/Render/$5 VPS | Must be a persistent process, *not* serverless |

### Why not Next.js on Vercel?

Serverless functions cannot hold a WhatsApp Web session, cannot run a durable cron, and
freeze between invocations. The moment you want Tier 1 automation you need one long-lived
process. Starting with Express avoids a migration later.

### Why SQLite over Supabase?

For **one** teacher on **one** laptop, SQLite is strictly better: no network latency, no
free-tier limits, works offline during a class when the wifi drops, and backup = copying a
file. Choose Supabase instead only if the teacher genuinely needs the app on both a phone and
a laptop simultaneously. Because we use Prisma, that switch is:

```diff
  datasource db {
-   provider = "sqlite"
+   provider = "postgresql"
    url      = env("DATABASE_URL")
  }
```

...plus converting the documented `String` status fields to real enums.

## 1.3 Component diagram

```
┌──────────────────────────────────────── Browser (RTL, ar) ────────────────────────────────────────┐
│  React SPA                                                                                        │
│  ┌───────────┐ ┌───────────┐ ┌────────────┐ ┌──────────┐ ┌────────────┐ ┌──────────┐              │
│  │ Students  │ │  Classes  │ │ Attendance │ │  Grades  │ │ Send Queue │ │ Settings │              │
│  │   CRUD    │ │ + Schedule│ │   Board    │ │  Entry   │ │ (Tier 0)   │ │Templates │              │
│  └───────────┘ └───────────┘ └────────────┘ └──────────┘ └────────────┘ └──────────┘              │
└───────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                            │ REST /api  (JSON)
┌───────────────────────────────────────────▼───────────────────────────────────────────────────────┐
│  Node.js + Express                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Routes  → Services (business rules) → Prisma (data access)                                  │  │
│  └─────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                            │                                                      │
│   attendance.service  ──┐                  │                                                      │
│   grades.service     ──┼──► enqueueMessage() ──► messages table (status = PENDING)                │
│   reports.service    ──┘         ▲                          │                                     │
│                                  │                          ▼                                     │
│                        ┌─────────┴──────────┐     ┌─────────────────────┐                         │
│                        │  Template Engine   │     │  Outbox Dispatcher  │                         │
│                        │  {{vars}} → Arabic │     │  (skipped on Tier 0)│                         │
│                        └────────────────────┘     └──────────┬──────────┘                         │
│                                                              ▼                                     │
│                                              ┌───────────────────────────────┐                    │
│  ┌────────────────────┐                      │   MessagingProvider (port)    │                    │
│  │ Cron jobs          │                      ├───────────────────────────────┤                    │
│  │ • 06:00 build      │                      │ WaLink │ GreenApi │ Twilio    │                    │
│  │   today's sessions │                      └────┬────────┬─────────┬───────┘                    │
│  │ • */2min drain     │                           │        │         │                            │
│  │   outbox           │                    teacher taps  HTTP      HTTP                           │
│  │ • 1st of month     │                           ▼        ▼         ▼                            │
│  │   monthly reports  │                    ┌──────────────────────────────┐                       │
│  └────────────────────┘                    │  Parent's WhatsApp / SMS     │                       │
│                                            └──────────────────────────────┘                       │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────┐    │
│  │  SQLite file  (data/tutor.db)  — nightly copy to backups/tutor-YYYY-MM-DD.db             │    │
│  └──────────────────────────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 1.4 Folder layout

```
mr-ahmed/
├─ prisma/
│  ├─ schema.prisma          # single source of truth for the DB
│  └─ seed.ts                # Arabic templates + default settings
├─ db/
│  └─ schema.sql             # equivalent raw DDL (if you skip Prisma)
├─ server/
│  ├─ src/
│  │  ├─ index.ts            # express bootstrap + cron registration
│  │  ├─ db.ts               # PrismaClient singleton
│  │  ├─ routes/             # students, classes, sessions, attendance,
│  │  │                      # assessments, grades, messages, templates,
│  │  │                      # settings, reports
│  │  ├─ services/           # ALL business rules live here
│  │  │  ├─ attendance.service.ts
│  │  │  ├─ grades.service.ts
│  │  │  ├─ reports.service.ts
│  │  │  └─ settings.service.ts
│  │  ├─ messaging/
│  │  │  ├─ provider.ts      # the port (interface)
│  │  │  ├─ wa-link.ts       # Tier 0 adapter
│  │  │  ├─ green-api.ts     # Tier 1 adapter
│  │  │  ├─ twilio.ts        # Tier 2 adapter
│  │  │  ├─ outbox.ts        # enqueueMessage() + dispatcher
│  │  │  └─ template.ts      # {{var}} renderer + Arabic date/number helpers
│  │  ├─ jobs/               # node-cron definitions
│  │  └─ lib/phone.ts        # E.164 normalisation (incl. Arabic-Indic digits)
│  └─ package.json
├─ web/
│  ├─ src/
│  │  ├─ main.tsx            # sets dir="rtl" lang="ar"
│  │  ├─ api/client.ts
│  │  ├─ pages/
│  │  └─ components/
│  └─ package.json
└─ docs/                     # these files
```

**The one architectural rule to hold:** routes never talk to Prisma directly, and they never
build a message. Routes validate input and call a service; only services enqueue messages.
That keeps "marking a student absent" and "notifying the parent" in one testable function
instead of scattered across the UI.

## 1.5 REST API surface

| Method | Path | Purpose |
|---|---|---|
| `GET/POST` | `/api/students` | list (filter `?q=&classId=&active=`) / create |
| `PATCH/DELETE` | `/api/students/:id` | update / soft-delete (`isActive=false`) |
| `GET` | `/api/students/:id/report?from=&to=` | attendance + grade summary |
| `GET/POST` | `/api/classes` | list with slots & student counts / create |
| `PATCH/DELETE` | `/api/classes/:id` | update (incl. schedule slots) / delete |
| `POST/DELETE` | `/api/classes/:id/students` | enrol / unenrol |
| `POST` | `/api/sessions/ensure?date=` | idempotently materialise sessions from the weekly schedule |
| `GET` | `/api/sessions?date=&classId=` | day view |
| `GET` | `/api/sessions/:id/roster` | students + any marks already saved |
| `POST` | `/api/sessions/:id/attendance` | **bulk upsert marks → enqueues absence/late alerts** |
| `GET/POST` | `/api/assessments` | list / create quiz or exam |
| `POST` | `/api/assessments/:id/grades` | **bulk upsert scores → enqueues low-grade alerts** |
| `GET` | `/api/messages?status=&studentId=` | outbox / history |
| `POST` | `/api/messages/:id/send` | dispatch now (Tier 1/2) |
| `POST` | `/api/messages/:id/mark-sent` | Tier 0: teacher confirms they hit Send |
| `POST` | `/api/messages/preview` | render a template without saving |
| `POST` | `/api/reports/monthly/queue?month=` | queue a report for every active student |
| `GET/PUT` | `/api/templates` | edit the Arabic message templates |
| `GET/PUT` | `/api/settings` | threshold, auto-send flags, provider config |

## 1.6 Non-functional decisions worth making now

- **Dates as `TEXT` (`"2026-09-05"`, `"16:00"`), not `DateTime`.** A class at 4pm is at 4pm
  regardless of timezone. Storing UTC timestamps for school schedules causes off-by-one-day
  bugs the moment the server clock or DST differs from the tutor's. Only true instants
  (`createdAt`, `sentAt`) get real timestamps.
- **Idempotent alerts via `dedupeKey`.** `ABSENCE:{sessionId}:{studentId}` is `UNIQUE` on the
  messages table. The teacher can re-save the attendance grid ten times; the parent gets one
  message. This is the single most important correctness detail in the system.
- **Soft-delete students.** Deleting a student who has a year of attendance history destroys
  the report data. `isActive = false` hides them from the daily grid but keeps history.
- **Quiet hours.** Do not send an absence alert at 23:40. The dispatcher holds messages
  created inside `quietHoursStart..quietHoursEnd` until the window opens.
- **Auth.** Single user → a single password + `express-session` cookie is enough. Do not build
  multi-tenancy for one teacher; add it only if the tool is ever sold to a second tutor.
- **Backups.** SQLite means `fs.copyFile()` on a cron. Ship this in week one, not week ten.
