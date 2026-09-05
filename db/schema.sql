-- Student Management & Notification System — raw SQLite DDL
-- Equivalent to prisma/schema.prisma. Use this only if you skip Prisma
-- (e.g. better-sqlite3 directly). Otherwise `prisma migrate` generates it.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;   -- concurrent reads while the teacher saves marks

-- ─────────────────────────────── People ───────────────────────────────

CREATE TABLE IF NOT EXISTS students (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  parent_name   TEXT NOT NULL,
  parent_phone  TEXT NOT NULL,                     -- E.164 "+201001234567"
  alt_phone     TEXT,
  grade_level   TEXT NOT NULL,
  notes         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_students_active ON students(is_active);
CREATE INDEX IF NOT EXISTS idx_students_phone  ON students(parent_phone);

-- ─────────────────────────── Classes & schedule ───────────────────────

CREATE TABLE IF NOT EXISTS class_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  subject     TEXT NOT NULL,
  grade_level TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#2563eb',
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedule_slots (
  id             TEXT PRIMARY KEY,
  class_group_id TEXT NOT NULL REFERENCES class_groups(id) ON DELETE CASCADE,
  weekday        INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  start_time     TEXT NOT NULL,                    -- "16:00"
  end_time       TEXT NOT NULL,
  location       TEXT,
  UNIQUE (class_group_id, weekday, start_time)
);
CREATE INDEX IF NOT EXISTS idx_slots_weekday ON schedule_slots(weekday);

CREATE TABLE IF NOT EXISTS enrollments (
  id             TEXT PRIMARY KEY,
  student_id     TEXT NOT NULL REFERENCES students(id)     ON DELETE CASCADE,
  class_group_id TEXT NOT NULL REFERENCES class_groups(id) ON DELETE CASCADE,
  joined_at      TEXT NOT NULL DEFAULT (datetime('now')),
  is_active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (student_id, class_group_id)
);
CREATE INDEX IF NOT EXISTS idx_enroll_class ON enrollments(class_group_id, is_active);

-- ──────────────────────────── Attendance ──────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  class_group_id TEXT NOT NULL REFERENCES class_groups(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,                    -- "2026-09-05" local date
  start_time     TEXT NOT NULL,
  end_time       TEXT,
  topic          TEXT,
  status         TEXT NOT NULL DEFAULT 'HELD'
                 CHECK (status IN ('PLANNED','HELD','CANCELLED')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (class_group_id, date, start_time)        -- idempotent generation
);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);

CREATE TABLE IF NOT EXISTS attendance (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status       TEXT NOT NULL
               CHECK (status IN ('PRESENT','ABSENT','LATE','EXCUSED')),
  minutes_late INTEGER,
  note         TEXT,
  marked_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_att_student ON attendance(student_id, status);

-- ────────────────────────── Grades & performance ──────────────────────

CREATE TABLE IF NOT EXISTS assessments (
  id             TEXT PRIMARY KEY,
  class_group_id TEXT NOT NULL REFERENCES class_groups(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'QUIZ'
                 CHECK (type IN ('QUIZ','EXAM','HOMEWORK')),
  max_score      REAL NOT NULL CHECK (max_score > 0),
  date           TEXT NOT NULL,
  weight         REAL NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assess_class ON assessments(class_group_id, date);

CREATE TABLE IF NOT EXISTS grades (
  id            TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES students(id)    ON DELETE CASCADE,
  score         REAL CHECK (score IS NULL OR score >= 0), -- NULL = did not sit
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (assessment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_grades_student ON grades(student_id);

-- Percentage is derived, never stored — keeps score and max_score the single truth.
CREATE VIEW IF NOT EXISTS grade_percentages AS
SELECT g.id, g.student_id, g.assessment_id, a.class_group_id, a.title, a.date,
       g.score, a.max_score,
       ROUND(g.score * 100.0 / a.max_score, 1) AS percentage
FROM grades g
JOIN assessments a ON a.id = g.assessment_id
WHERE g.score IS NOT NULL;

-- ───────────────────────────── Messaging ──────────────────────────────

CREATE TABLE IF NOT EXISTS message_templates (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  student_id      TEXT REFERENCES students(id) ON DELETE SET NULL,
  to_phone        TEXT NOT NULL,
  channel         TEXT NOT NULL DEFAULT 'WHATSAPP'
                  CHECK (channel IN ('WHATSAPP','SMS')),
  template_key    TEXT,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED','CANCELLED')),
  provider        TEXT,
  provider_msg_id TEXT,
  error           TEXT,
  related_type    TEXT,
  related_id      TEXT,
  dedupe_key      TEXT UNIQUE,   -- "ABSENCE:{session_id}:{student_id}"
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_status  ON messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_student ON messages(student_id, created_at);

-- ───────────────────────────── Settings ───────────────────────────────

CREATE TABLE IF NOT EXISTS settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  tutor_name           TEXT NOT NULL DEFAULT 'الأستاذ أحمد',
  center_name          TEXT NOT NULL DEFAULT '',
  default_country_code TEXT NOT NULL DEFAULT '+20',
  low_grade_threshold  INTEGER NOT NULL DEFAULT 60,
  auto_send_absence    INTEGER NOT NULL DEFAULT 1,
  auto_send_late       INTEGER NOT NULL DEFAULT 0,
  auto_send_low_grade  INTEGER NOT NULL DEFAULT 1,
  quiet_hours_start    TEXT NOT NULL DEFAULT '22:00',
  quiet_hours_end      TEXT NOT NULL DEFAULT '08:00',
  provider             TEXT NOT NULL DEFAULT 'WA_LINK'
                       CHECK (provider IN ('WA_LINK','GREEN_API','TWILIO')),
  provider_config      TEXT NOT NULL DEFAULT '{}',
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (id) VALUES (1);
