/**
 * TypeScript mirrors of every REST response shape the server exposes.
 *
 * Field names are the camelCase Prisma column names — see
 * `server/prisma/schema.prisma`, which is the single source of truth.
 * SQLite has no native enums, so status columns are plain strings on the
 * server; here they are narrowed to string-literal unions.
 *
 * Timestamps (`createdAt`, `sentAt`, …) arrive as ISO-8601 strings because
 * they travel through JSON. Calendar dates (`date`) and wall-clock times
 * (`startTime`) are stored as plain text — "2026-09-05" and "16:00" — and
 * must never be parsed as UTC instants.
 */

/* ────────────────────────────── Enum-ish unions ───────────────────────── */

export type AttendanceStatus = "PRESENT" | "ABSENT" | "LATE" | "EXCUSED";
export type SessionStatus = "PLANNED" | "HELD" | "CANCELLED";
export type AssessmentType = "QUIZ" | "EXAM" | "HOMEWORK";
export type MessageStatus =
  | "PENDING"
  | "SENT"
  | "FAILED"
  | "SKIPPED"
  | "CANCELLED";
export type MessageChannel = "WHATSAPP" | "SMS";
export type ProviderName = "WA_LINK" | "GREEN_API" | "TWILIO";
export type RelatedType = "ATTENDANCE" | "GRADE" | "REPORT";
export type TemplateKey =
  | "ABSENCE"
  | "LATE"
  | "LOW_GRADE"
  | "MONTHLY_REPORT"
  | "CUSTOM";

/* ──────────────────────────────── Students ────────────────────────────── */

/** The raw `Student` row, without any joined data. */
export interface StudentBase {
  id: string;
  name: string;
  parentName: string;
  /** Stored E.164, e.g. "+201001234567". */
  parentPhone: string;
  altPhone: string | null;
  gradeLevel: string;
  notes: string | null;
  /** Soft delete: false hides the student but keeps their history. */
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A class chip as embedded in student payloads. */
export interface ClassChip {
  id: string;
  name: string;
  color: string;
}

/** `GET /api/students` — a student plus the classes they are enrolled in. */
export interface Student extends StudentBase {
  classes: ClassChip[];
}

/** Alias kept for readability at call sites that list students. */
export type StudentWithClasses = Student;

export interface RecentGrade {
  id: string;
  assessmentId: string;
  title: string;
  /** "2026-09-05" */
  date: string;
  type: AssessmentType;
  score: number | null;
  maxScore: number;
  /** null when the student did not sit the test. */
  percentage: number | null;
  note?: string | null;
  subject?: string;
}

export interface RecentAttendance {
  id: string;
  sessionId: string;
  /** "2026-09-05" */
  date: string;
  status: AttendanceStatus;
  minutesLate: number | null;
  note: string | null;
  className?: string;
  subject?: string;
  startTime?: string;
}

/** `GET /api/students/:id` */
export interface StudentDetail extends Student {
  report: StudentReport;
  recentGrades: RecentGrade[];
  recentAttendance: RecentAttendance[];
}

/** `GET /api/students/:id/report?from=&to=` */
export interface StudentReport {
  sessionsTotal: number;
  presentCount: number;
  absentCount: number;
  lateCount: number;
  /** Whole percent, 0–100. */
  attendanceRate: number;
  assessmentsCount: number;
  averagePercentage: number;
  bestPercentage: number;
  worstPercentage: number;
}

/** Body for `POST /api/students` and `PATCH /api/students/:id`. */
export interface StudentInput {
  name: string;
  parentName: string;
  parentPhone: string;
  altPhone?: string | null;
  gradeLevel: string;
  notes?: string | null;
  isActive?: boolean;
}

/* ─────────────────────────── Classes & schedule ───────────────────────── */

/** The raw `ClassGroup` row. */
export interface ClassGroupBase {
  id: string;
  name: string;
  subject: string;
  gradeLevel: string;
  /** Hex colour used for UI chips, e.g. "#2563eb". */
  color: string;
  isActive: boolean;
  createdAt: string;
}

/** The trimmed class object embedded in sessions and assessments. */
export interface ClassGroupRef {
  id: string;
  name: string;
  subject: string;
  color: string;
  gradeLevel: string;
}

export interface ScheduleSlot {
  id: string;
  classGroupId: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** "16:00" */
  startTime: string;
  /** "17:30" */
  endTime: string;
  location: string | null;
}

/** `GET /api/classes` */
export interface ClassGroup extends ClassGroupBase {
  slots: ScheduleSlot[];
  studentCount: number;
}

export interface ScheduleSlotInput {
  weekday: number;
  startTime: string;
  endTime: string;
  location?: string | null;
}

/** Body for `POST /api/classes` and `PATCH /api/classes/:id`. */
export interface ClassInput {
  name: string;
  subject: string;
  gradeLevel: string;
  color: string;
  slots: ScheduleSlotInput[];
  isActive?: boolean;
}

/** Body for `POST /api/classes/:id/students` — replaces the enrolment set. */
export interface EnrolmentInput {
  studentIds: string[];
}

/* ─────────────────────────────── Attendance ───────────────────────────── */

export interface RosterEntry {
  studentId: string;
  name: string;
  parentName: string;
  parentPhone: string;
  gradeLevel: string;
  /** null = not marked yet. */
  status: AttendanceStatus | null;
  minutesLate: number | null;
  note: string | null;
}

export interface AttendanceCounts {
  present: number;
  absent: number;
  late: number;
  excused: number;
  unmarked: number;
  total: number;
}

/** `GET /api/sessions?date=YYYY-MM-DD` */
export interface SessionWithRoster {
  id: string;
  /** "2026-09-05" */
  date: string;
  /** "16:00" */
  startTime: string;
  endTime: string | null;
  topic: string | null;
  status: SessionStatus;
  classGroup: ClassGroupRef;
  roster: RosterEntry[];
  counts: AttendanceCounts;
}

/** One row of the `POST /api/sessions/:id/attendance` body. */
export interface AttendanceMark {
  studentId: string;
  status: AttendanceStatus;
  minutesLate?: number | null;
  note?: string | null;
}

/** `POST /api/sessions/ensure?date=` */
export interface EnsureSessionsResult {
  created: number;
}

/* ──────────────────────── Assessments & grades ────────────────────────── */

/** The raw `Assessment` row. */
export interface AssessmentBase {
  id: string;
  classGroupId: string;
  title: string;
  type: AssessmentType;
  maxScore: number;
  /** "2026-09-05" */
  date: string;
  weight: number;
  createdAt: string;
}

/** `GET /api/assessments?classId=` */
export interface Assessment extends AssessmentBase {
  classGroup: ClassGroupRef;
  /** How many students already have a non-null score. */
  gradedCount: number;
  averagePercentage: number;
}

export interface AssessmentEntry {
  studentId: string;
  name: string;
  /** null = did not sit the test; excluded from averages, never alerted on. */
  score: number | null;
  percentage: number | null;
  note: string | null;
}

/** `GET /api/assessments/:id` */
export interface AssessmentDetail extends AssessmentBase {
  classGroup: ClassGroupRef;
  entries: AssessmentEntry[];
  gradedCount?: number;
  averagePercentage?: number;
}

/** Body for `POST /api/assessments`. */
export interface AssessmentInput {
  classGroupId: string;
  title: string;
  type: AssessmentType;
  maxScore: number;
  date: string;
  weight?: number;
}

/** One row of the `POST /api/assessments/:id/grades` body. */
export interface GradeEntryInput {
  studentId: string;
  score: number | null;
  note?: string | null;
}

/**
 * An alert that had already left the queue by the time the mark or score behind
 * it was corrected — nothing can withdraw it, the parent has the message. The
 * teacher is told so they can decide whether to send a correction by hand.
 */
export interface SentAlreadyNotice {
  studentId: string;
  studentName: string;
  templateKey: TemplateKey;
}

/** Returned by both bulk-save endpoints (attendance and grades). */
export interface SaveResult {
  saved: number;
  queued: number;
  /** Queued alerts withdrawn because the mark/score that raised them changed. */
  cancelled: number;
  /** Alerts that were already sent when the correction arrived — see above. */
  sentAlready: SentAlreadyNotice[];
}

/* ─────────────────────────────── Messaging ────────────────────────────── */

/** `GET /api/messages?status=&studentId=` */
export interface Message {
  id: string;
  studentId: string | null;
  studentName: string | null;
  parentName: string | null;
  /** E.164 snapshot taken at enqueue time. */
  toPhone: string;
  channel: MessageChannel;
  templateKey: TemplateKey | null;
  /** Fully rendered Arabic text, frozen when the message was queued. */
  body: string;
  status: MessageStatus;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  /** Computed server-side by `toWaLink()` — Tier 0 click-to-chat URL. */
  waLink: string;
  /**
   * The same chat as a `whatsapp://send?phone=…&text=…` link. Inside the APK
   * this is the one that actually opens the WhatsApp app; `waLink` only ever
   * reaches its web landing page there. See lib/openExternal.ts.
   */
  waAppLink: string;
  provider?: ProviderName | null;
  attempts?: number;
  relatedType?: RelatedType | null;
  relatedId?: string | null;
}

/** `POST /api/messages/:id/send` */
export interface SendMessageResult {
  ok: boolean;
  error?: string;
}

/** `POST /api/messages/preview` */
export interface PreviewInput {
  templateKey: TemplateKey;
  studentId?: string;
}

export interface PreviewResult {
  body: string;
}

/** `GET/PUT /api/templates` */
export interface MessageTemplate {
  id: string;
  key: TemplateKey;
  name: string;
  /** Arabic body containing {{placeholders}}. */
  body: string;
  isActive: boolean;
  updatedAt: string;
}

export interface MessageTemplateInput {
  key: TemplateKey;
  name: string;
  body: string;
  isActive: boolean;
}

/* ─────────────────────────────── Settings ─────────────────────────────── */

/** Credential blob — persisted as a JSON string, parsed in API responses. */
export interface ProviderConfig {
  /** Green API */
  idInstance?: string;
  apiTokenInstance?: string;
  apiUrl?: string;
  /** Twilio */
  accountSid?: string;
  authToken?: string;
  from?: string;
  channel?: MessageChannel;
  [key: string]: unknown;
}

/** `GET/PUT /api/settings` — the single id=1 row. */
export interface Settings {
  id: number;
  tutorName: string;
  centerName: string;
  /** Used to normalise "01001234567" → "+201001234567". */
  defaultCountryCode: string;
  /** Percent below which a LOW_GRADE alert is queued. */
  lowGradeThreshold: number;
  autoSendAbsence: boolean;
  autoSendLate: boolean;
  autoSendLowGrade: boolean;
  /** "22:00" */
  quietHoursStart: string;
  /** "08:00" */
  quietHoursEnd: string;
  provider: ProviderName;
  providerConfig: ProviderConfig;
  /** The teacher's OWN WhatsApp number — the sender, not a parent. "" until linked. */
  tutorWhatsapp: string;
  /** Link state of that sending account; see `WhatsappState`. */
  whatsappState: WhatsappState;
  /** ISO-8601 of the last confirmed link, null when the account was never linked. */
  whatsappLinkedAt: string | null;
  updatedAt: string;
}

export type SettingsInput = Partial<Omit<Settings, "id" | "updatedAt">>;

/* ─────────────────────── WhatsApp linking (/whatsapp) ─────────────────── */

/**
 * Mirrors the `Setting.whatsappState` column documented in schema.prisma.
 *
 *  UNKNOWN        — never checked, or the credentials were only just saved.
 *  NOT_AUTHORIZED — the credentials work, but no phone has scanned the QR yet.
 *  QR_PENDING     — a QR code is waiting to be scanned right now.
 *  AUTHORIZED     — linked: alerts leave the teacher's own number by themselves.
 *  BLOCKED        — WhatsApp blocked or suspended the number.
 *  ERROR          — the gateway answered with a fault (bad token, expired plan…).
 */
export type WhatsappState =
  | "UNKNOWN"
  | "NOT_AUTHORIZED"
  | "QR_PENDING"
  | "AUTHORIZED"
  | "BLOCKED"
  | "ERROR";

/**
 * `GET /api/whatsapp/status`, and the answer to `/link`, `/refresh`, `/unlink`.
 *
 * Mirrors `WhatsappStatus` in server/src/routes/whatsapp.ts field for field.
 * Note what is **not** here: `apiTokenInstance`. The token is write-only — it
 * goes in through `/link` and no endpoint ever echoes it back, which is why
 * `configured` exists at all.
 */
export interface WhatsappStatus {
  /** The active messaging provider — WA_LINK until a number is actually linked. */
  provider: ProviderName;
  state: WhatsappState;
  /** `state` in Arabic, ready to print. */
  stateLabel: string;
  /** E.164 of the linked sending number — "" while it is not known. */
  phone: string;
  /** ISO-8601; null when the account was never linked. */
  linkedAt: string | null;
  /** False until both Green API credentials are stored. */
  configured: boolean;
  /** Arabic diagnostic from the last live probe. Never carries a secret. */
  warning?: string;
}

/**
 * `GET /api/whatsapp/qr` — polled every few seconds while the QR is on screen.
 *
 * Always a 200 with a `kind`, never a 4xx: a screen that polls must not fill the
 * console with errors just because the credentials are not in yet.
 */
export type WhatsappQr =
  | { kind: "qr"; pngDataUri: string }
  | { kind: "already-linked" }
  | { kind: "error"; error: string };

/** Body for `POST /api/whatsapp/link`. */
export interface WhatsappLinkRequest {
  idInstance: string;
  apiTokenInstance: string;
  /** Only for a self-hosted gateway; defaults to https://api.green-api.com. */
  apiUrl?: string;
}

/* ──────────────────────────── Reports & dashboard ─────────────────────── */

/** `POST /api/reports/monthly/queue?month=YYYY-MM` */
export interface QueueReportsResult {
  queued: number;
}

export interface LowPerformer {
  studentId: string;
  name: string;
  averagePercentage: number;
}

export interface ChronicAbsentee {
  studentId: string;
  name: string;
  absentCount: number;
}

export interface DashboardTotals {
  students: number;
  classes: number;
  assessments: number;
}

/** `GET /api/dashboard` */
export interface DashboardData {
  todaySessions: SessionWithRoster[];
  /** Whole percent, 0–100. */
  weekAttendanceRate: number;
  pendingMessages: number;
  lowPerformers: LowPerformer[];
  chronicAbsentees: ChronicAbsentee[];
  totals: DashboardTotals;
}

/** `GET /api/health` */
export interface HealthResult {
  ok: true;
}

/* ────────────────────── Users, auth & the audit trail ─────────────────── */

/**
 * Two roles only.
 *  - OWNER     — everything, plus the audit log and user management.
 *  - ASSISTANT — full access to all *data* (students, classes, attendance,
 *                grades, messages, templates, settings) but never sees
 *                `/api/audit` or `/api/users`.
 */
export type UserRole = "OWNER" | "ASSISTANT";

export type AuditAction =
  | "LOGIN"
  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "ATTENDANCE"
  | "GRADES"
  | "MESSAGE"
  | "SETTINGS";

export type AuditEntity =
  | "Student"
  | "ClassGroup"
  | "Session"
  | "Attendance"
  | "Assessment"
  | "Grade"
  | "Message"
  | "MessageTemplate"
  | "Setting"
  | "User";

/**
 * `GET /api/users` · `GET /api/auth/me`.
 * `passwordHash` never leaves the server, so it is absent here by design.
 */
export interface User {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** Body for `POST /api/auth/login`. */
export interface LoginInput {
  username: string;
  password: string;
}

/** `POST /api/auth/login` — the Bearer token plus the account it belongs to. */
export interface LoginResponse {
  token: string;
  user: User;
}

/**
 * Body for `POST /api/users` (where `password` is required) and for
 * `PATCH /api/users/:id` (where every field is optional and `password` is
 * never sent — resetting goes through its own endpoint).
 */
export interface UserInput {
  name: string;
  username: string;
  role: UserRole;
  password?: string;
  isActive?: boolean;
}

/** Body for `POST /api/users/:id/password`. */
export interface PasswordResetInput {
  password: string;
}

/**
 * One row of the append-only trail. `userName` / `userRole` are snapshots taken
 * when the action happened, so a deleted account still reads correctly.
 * `before` / `after` are JSON *strings* — the raw column value.
 */
export interface AuditEntry {
  id: string;
  userId: string | null;
  userName: string;
  userRole: UserRole;
  action: AuditAction;
  entity: AuditEntity;
  entityId: string | null;
  /** Ready-to-read Arabic sentence written by the server. */
  summary: string;
  before: string | null;
  after: string | null;
  ip: string | null;
  createdAt: string;
}

/** Query string for `GET /api/audit`. An empty string means "no filter". */
export interface AuditFilters {
  userId?: string;
  action?: AuditAction | "";
  entity?: AuditEntity | "";
  /** "2026-09-01", inclusive. */
  from?: string;
  /** "2026-09-30", inclusive. */
  to?: string;
  /** Free text matched against the Arabic summary. */
  q?: string;
  limit?: number;
}

/** `GET /api/audit` — either a bare array or this envelope. */
export interface AuditPage {
  entries: AuditEntry[];
  total?: number;
  nextCursor?: string | null;
}
