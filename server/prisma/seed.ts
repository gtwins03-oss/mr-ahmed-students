/**
 * Idempotent seed — safe to run as many times as you like.
 *
 * Everything below goes through `upsert`, and anything the teacher can edit
 * from the UI (settings, message templates, the OWNER's password) uses an
 * EMPTY `update` block so a re-seed never silently overwrites their wording,
 * their credentials, or their login.
 *
 * The single exception is the one-time owner rename in `resolveOwner()`: a
 * database still holding the legacy "ahmed" account is migrated in place to the
 * configured OWNER_USERNAME, keeping the same id so the audit trail follows it.
 * Once migrated, that branch can never fire again.
 *
 *   npm run --prefix server db:seed
 */
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

// The seed is often run directly (`npx tsx prisma/seed.ts`), which — unlike the
// server bootstrap — does not load server/.env by itself.
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const prisma = new PrismaClient();

// ───────────────────────── Arabic templates (docs/02-messaging.md §2.4) ─────────────────────────

const ABSENCE_BODY = `السلام عليكم ورحمة الله وبركاته
عزيزي ولي أمر الطالب/ة: {{student_name}}

نود إحاطتكم علماً بأن الطالب/ة تغيّب اليوم عن حصة {{subject}}
📅 التاريخ: {{date_ar}}
🕐 الموعد: {{time_ar}}

نرجو المتابعة والتواصل معنا لأي استفسار.
مع خالص التقدير،
{{teacher_name}}`;

const LATE_BODY = `السلام عليكم ورحمة الله وبركاته
عزيزي ولي أمر الطالب/ة: {{student_name}}

نفيدكم بأن الطالب/ة حضر متأخراً بمقدار {{minutes_late}} دقيقة
عن حصة {{subject}} يوم {{date_ar}}.

نرجو الحرص على الحضور في الموعد المحدد حفاظاً على استفادته الكاملة.
مع خالص التقدير،
{{teacher_name}}`;

const LOW_GRADE_BODY = `السلام عليكم ورحمة الله وبركاته
عزيزي ولي أمر الطالب/ة: {{student_name}}

نتيجة «{{assessment_title}}» في مادة {{subject}} بتاريخ {{date_ar}}:
📊 الدرجة: {{score}} من {{max_score}}  ({{percentage}}%)

الدرجة أقل من المستوى المطلوب ({{threshold}}%). نرجو المتابعة معه في المنزل،
ونحن على استعداد لتقديم حصة تقوية إضافية إذا رغبتم.

مع خالص التقدير،
{{teacher_name}}`;

const MONTHLY_REPORT_BODY = `السلام عليكم ورحمة الله وبركاته
تقرير الطالب/ة: {{student_name}}
📆 الفترة: {{period_ar}}

▪️ الحضور
• عدد الحصص: {{sessions_total}}
• حضور: {{present_count}}
• غياب: {{absent_count}}
• تأخير: {{late_count}}
• نسبة الحضور: {{attendance_rate}}%

▪️ المستوى الدراسي
• عدد الاختبارات: {{assessments_count}}
• المتوسط العام: {{average_percentage}}%
• أعلى درجة: {{best_percentage}}%
• أقل درجة: {{worst_percentage}}%

{{teacher_note}}
شاكرين لكم حسن تعاونكم،
{{teacher_name}}`;

const TEMPLATES: { key: string; name: string; body: string }[] = [
  { key: "ABSENCE", name: "تنبيه غياب", body: ABSENCE_BODY },
  { key: "LATE", name: "تنبيه تأخير", body: LATE_BODY },
  { key: "LOW_GRADE", name: "تنبيه مستوى", body: LOW_GRADE_BODY },
  { key: "MONTHLY_REPORT", name: "التقرير الشهري", body: MONTHLY_REPORT_BODY },
];

// ───────────────────────────────── Branding ──────────────────────────────────

/**
 * The product name, mirrored from web/src/components/Brand.tsx (BRAND_NAME).
 * It seeds `Setting.centerName`, which is what the messaging layer prints at
 * the bottom of a parent's WhatsApp message.
 *
 * It is only ever *filled in*, never overwritten: the teacher can rename the
 * centre from «الإعدادات» and a re-seed must respect that. See `seedBranding()`.
 */
const CENTER_NAME = "Mr Ahmed Ibrahim Students";

// ─────────────────────────── The OWNER account ───────────────────────────────

/** Fallback used when server/.env has not been filled in yet. */
const DEFAULT_OWNER_USERNAME = "MrAhmed";
const OWNER_NAME = "الأستاذ أحمد";
const BCRYPT_ROUNDS = 10;

/**
 * There is deliberately NO default owner password in this file.
 *
 * A literal here would be committed to Git, and the moment the server is
 * deployed somewhere public by an operator who forgot to set OWNER_PASSWORD,
 * anyone who has read the repository can sign in as the OWNER — which means
 * every student record and every parent's phone number. A random password that
 * nobody knows fails safe; a known one fails open.
 *
 * So when OWNER_PASSWORD is absent we mint a strong random one and print it
 * once, loudly. Losing it is recoverable (re-seed, or reset from the UI);
 * shipping a guessable one is not.
 */
function generateOwnerPassword(): string {
  // Ambiguous glyphs (0/O, 1/l/I) removed — this gets read off a terminal.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(20);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/**
 * The username the owner account shipped with before it was renamed. A database
 * seeded with the old name is migrated in place (same id) rather than gaining a
 * second, orphaned account — see `resolveOwner()`.
 */
const LEGACY_OWNER_USERNAME = "ahmed";

/** Which of the three owner paths the seed took, for the Arabic summary line. */
type OwnerOutcome = "RENAMED" | "CREATED" | "UNCHANGED";

const OWNER_OUTCOME_AR: Record<OwnerOutcome, string> = {
  RENAMED: `تمت ترقية الحساب القديم "${LEGACY_OWNER_USERNAME}" إلى الاسم الجديد (نفس المعرّف — سجل النشاط محفوظ) وأُعيد ضبط كلمة المرور`,
  CREATED: "تم إنشاؤه الآن",
  UNCHANGED: "موجود مسبقاً، لم تُمس كلمة المرور",
};

// ───────────────────────────────── Demo data ─────────────────────────────────

const DEMO_CLASS_ID = "demo-class-thanawy-3";
const DEMO_GRADE_LEVEL = "الصف الثالث الثانوي";

/** One slot per weekday (0 = Sunday … 6 = Saturday) so a session exists whatever
 *  day the teacher first opens the app. */
const DEMO_SLOT_START = "16:00";
const DEMO_SLOT_END = "17:30";
const DEMO_SLOT_LOCATION = "قاعة ١";

const DEMO_STUDENTS: {
  id: string;
  name: string;
  parentName: string;
  parentPhone: string;
}[] = [
  { id: "demo-student-1", name: "أحمد محمود عبد الرحمن", parentName: "محمود عبد الرحمن", parentPhone: "+201001234567" },
  { id: "demo-student-2", name: "سارة خالد إبراهيم", parentName: "خالد إبراهيم", parentPhone: "+201112345678" },
  { id: "demo-student-3", name: "يوسف عمرو السيد", parentName: "عمرو السيد", parentPhone: "+201223456789" },
  { id: "demo-student-4", name: "مريم طارق حسن", parentName: "طارق حسن", parentPhone: "+201501234567" },
  { id: "demo-student-5", name: "عمر ياسر فتحي", parentName: "ياسر فتحي", parentPhone: "+201009876543" },
  { id: "demo-student-6", name: "نور الدين سامي عادل", parentName: "سامي عادل", parentPhone: "+201118765432" },
];

// ─────────────────────────────────── Seed ────────────────────────────────────

async function main(): Promise<void> {
  // SQLite will not create a missing directory for the .db file.
  const dataDir = path.resolve(__dirname, "..", "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // 1 ── the single settings row (id is always 1)
  await prisma.setting.upsert({
    where: { id: 1 },
    update: {}, // never clobber the teacher's configured provider/credentials
    create: {
      id: 1,
      tutorName: "الأستاذ أحمد",
      centerName: CENTER_NAME,
      defaultCountryCode: "+20",
      lowGradeThreshold: 60,
      autoSendAbsence: true,
      autoSendLate: false,
      autoSendLowGrade: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
      provider: "WA_LINK",
      providerConfig: "{}",
    },
  });

  // 1b ── fill in the centre name on databases seeded before it had a default
  await seedBranding();

  // 2 ── the four Arabic message templates
  for (const t of TEMPLATES) {
    await prisma.messageTemplate.upsert({
      where: { key: t.key },
      update: {}, // the teacher may have reworded these from Settings — leave them alone
      create: { key: t.key, name: t.name, body: t.body, isActive: true },
    });
  }

  // 3 ── demo class
  const classGroup = await prisma.classGroup.upsert({
    where: { name: "مجموعة تجريبية - ٣ ثانوي" },
    update: {},
    create: {
      id: DEMO_CLASS_ID,
      name: "مجموعة تجريبية - ٣ ثانوي",
      subject: "الرياضيات",
      gradeLevel: DEMO_GRADE_LEVEL,
      color: "#2563eb",
      isActive: true,
    },
  });

  // 4 ── seven weekly slots, one per weekday, so any test day has a session
  for (let weekday = 0; weekday <= 6; weekday++) {
    await prisma.scheduleSlot.upsert({
      where: {
        classGroupId_weekday_startTime: {
          classGroupId: classGroup.id,
          weekday,
          startTime: DEMO_SLOT_START,
        },
      },
      update: {},
      create: {
        classGroupId: classGroup.id,
        weekday,
        startTime: DEMO_SLOT_START,
        endTime: DEMO_SLOT_END,
        location: DEMO_SLOT_LOCATION,
      },
    });
  }

  // 5 ── six demo students, enrolled in the demo class
  for (const s of DEMO_STUDENTS) {
    const student = await prisma.student.upsert({
      where: { id: s.id },
      update: {},
      create: {
        id: s.id,
        name: s.name,
        parentName: s.parentName,
        parentPhone: s.parentPhone,
        gradeLevel: DEMO_GRADE_LEVEL,
        notes: "طالب تجريبي — يمكن حذفه بعد إدخال البيانات الحقيقية",
        isActive: true,
      },
    });

    await prisma.enrollment.upsert({
      where: {
        studentId_classGroupId: {
          studentId: student.id,
          classGroupId: classGroup.id,
        },
      },
      update: {},
      create: {
        studentId: student.id,
        classGroupId: classGroup.id,
        isActive: true,
      },
    });
  }

  // 6 ── the OWNER account (الأستاذ أحمد)
  const ownerUsername = (process.env.OWNER_USERNAME || DEFAULT_OWNER_USERNAME).trim();
  const configuredPassword = (process.env.OWNER_PASSWORD || "").trim();
  const ownerPasswordWasGenerated = configuredPassword === "";
  const ownerPassword = ownerPasswordWasGenerated ? generateOwnerPassword() : configuredPassword;
  const ownerOutcome = await resolveOwner(ownerUsername, ownerPassword);

  // ── summary ──
  const [settings, templateCount, classCount, slotCount, studentCount, enrollmentCount, userCount] =
    await Promise.all([
      prisma.setting.findUniqueOrThrow({ where: { id: 1 } }),
      prisma.messageTemplate.count(),
      prisma.classGroup.count(),
      prisma.scheduleSlot.count(),
      prisma.student.count(),
      prisma.enrollment.count(),
      prisma.user.count(),
    ]);

  console.log("");
  console.log("  ✅ تمت تهيئة قاعدة البيانات بنجاح");
  console.log(`  👤 اسم المُدرِّس:      ${settings.tutorName}`);
  console.log(`  🏷️  اسم المركز:        ${settings.centerName}`);
  console.log(`  📨 مزوّد الرسائل:     ${settings.provider} (روابط واتساب — بدون أي بيانات اعتماد)`);
  console.log(`  📝 قوالب الرسائل:     ${templateCount}`);
  console.log(`  🏫 المجموعات:         ${classCount}`);
  console.log(`  📅 مواعيد أسبوعية:    ${slotCount} (حصة يومية ${DEMO_SLOT_START} - ${DEMO_SLOT_END})`);
  console.log(`  🎓 الطلاب:            ${studentCount}`);
  console.log(`  🔗 الاشتراكات:        ${enrollmentCount}`);
  console.log(
    `  🔐 المستخدمون:        ${userCount} (المالك: ${ownerUsername} — ${OWNER_OUTCOME_AR[ownerOutcome]})`
  );
  console.log("");
  console.log("  ℹ️  البيانات التجريبية جاهزة — افتح التطبيق وسجّل الحضور فوراً.");
  console.log("");

  printOwnerSecurityWarning(
    ownerUsername,
    ownerPassword,
    ownerOutcome,
    ownerPasswordWasGenerated
  );
}

/**
 * Backfills `Setting.centerName` — and only ever backfills it.
 *
 * Older databases were seeded with an empty centre name, so the branded default
 * would never reach them through `create`. Writing it unconditionally is not an
 * option either: the teacher can set the centre name from «الإعدادات», and that
 * string is printed in every parent's WhatsApp message. So the rule is exactly
 * one direction — empty (or whitespace) gets the product name, anything else is
 * left alone. Idempotent: the second run finds a non-empty value and no-ops.
 */
async function seedBranding(): Promise<void> {
  const settings = await prisma.setting.findUnique({ where: { id: 1 } });
  if (!settings || settings.centerName.trim() !== "") return;

  await prisma.setting.update({ where: { id: 1 }, data: { centerName: CENTER_NAME } });
  console.log(`  🏷️  تم ضبط اسم المركز الافتراضي: "${CENTER_NAME}" (كان فارغاً).`);
}

/**
 * Settles the owner account and reports which of three paths ran. Deliberately
 * NOT a blind upsert: an account already carrying the configured username must
 * never have its password — or its name, if it was renamed from the UI — reset
 * by a re-seed.
 *
 *   UNCHANGED — the configured owner already exists → left completely alone.
 *   RENAMED   — no such owner, but the legacy "ahmed" account is still there →
 *               renamed IN PLACE (same id, so every AuditLog row stays attached)
 *               and its password reset to OWNER_PASSWORD. This is the upgrade
 *               path for databases seeded before the rename.
 *   CREATED   — a fresh database → the owner is created.
 *
 * Idempotent: the second run always lands on UNCHANGED.
 */
async function resolveOwner(username: string, password: string): Promise<OwnerOutcome> {
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return "UNCHANGED";

  // Only ever consult the legacy name when it is genuinely a *different* name.
  const legacy =
    username === LEGACY_OWNER_USERNAME
      ? null
      : await prisma.user.findUnique({ where: { username: LEGACY_OWNER_USERNAME } });

  if (legacy) {
    await prisma.user.update({
      where: { id: legacy.id }, // keep the id — the audit-log history hangs off it
      data: {
        username,
        passwordHash: bcrypt.hashSync(password, BCRYPT_ROUNDS),
        role: "OWNER",
        isActive: true,
      },
    });
    console.log(
      `  🔄 تمت إعادة تسمية حساب المالك من "${LEGACY_OWNER_USERNAME}" إلى "${username}" مع الاحتفاظ بنفس المعرّف (${legacy.id}) وإعادة ضبط كلمة المرور.`
    );
    return "RENAMED";
  }

  await prisma.user.create({
    data: {
      name: OWNER_NAME,
      username,
      passwordHash: bcrypt.hashSync(password, BCRYPT_ROUNDS),
      role: "OWNER",
      isActive: true,
    },
  });
  console.log(`  ➕ لم يوجد أي حساب مالك — تم إنشاء "${username}" الآن.`);
  return "CREATED";
}

/** Loud, impossible-to-miss reminder to change the default credentials. */
function printOwnerSecurityWarning(
  username: string,
  password: string,
  outcome: OwnerOutcome,
  passwordWasGenerated: boolean
): void {
  // RENAMED counts as "touched": the password was just reset to the .env value.
  const touched = outcome !== "UNCHANGED";
  const weakSecret =
    !process.env.JWT_SECRET || process.env.JWT_SECRET === "change-me-to-a-long-random-string";

  // Nothing to shout about: a real password and a real JWT secret are in place.
  if (!touched && !passwordWasGenerated && !weakSecret) return;

  console.log("  ══════════════════════════════════════════════════════════");
  console.log("  ⚠️   تنبيه أمني مهم — اقرأ هذا السطر قبل أي شيء آخر");
  console.log("  ══════════════════════════════════════════════════════════");
  console.log("");
  console.log(`  👤 اسم المستخدم (المالك):  ${username}`);
  if (passwordWasGenerated) {
    // Printed exactly once, and stored nowhere. OWNER_PASSWORD was not set, so
    // this run minted a random one rather than falling back to a value that
    // lives in the repository.
    console.log(`  🔑 كلمة المرور المولّدة:   ${password}`);
    console.log("");
    console.log("  ❗ انسخ كلمة المرور دي دلوقتي — مش هتتعرض تاني ومش متخزّنة في أي ملف.");
    console.log("  ❗ لو ضاعت: غيّرها من صفحة «المستخدمون»، أو حط OWNER_PASSWORD في .env");
    console.log("     واحذف حساب المالك ثم أعد تشغيل db:seed.");
    console.log("");
    console.log("  ℹ️  السبب: OWNER_PASSWORD مش مضبوطة. لا توجد كلمة مرور افتراضية في الكود");
    console.log("     عن قصد — كلمة مرور مكتوبة في المستودع تعني أن أي شخص يقرأ الكود");
    console.log("     يستطيع الدخول كمالك بمجرد نشر الخادم على الإنترنت.");
  } else {
    console.log("  🔑 كلمة المرور:            كما هي في ملف .env (OWNER_PASSWORD)");
  }
  if (weakSecret) {
    console.log("");
    console.log("  ❗ وغيّر أيضاً JWT_SECRET في ملف .env إلى نص عشوائي طويل قبل النشر،");
    console.log("     وإلا صار بإمكان أي شخص تزوير رمز دخول والدخول كمالك.");
  }
  console.log("");
  console.log("  ══════════════════════════════════════════════════════════");
  console.log("");
}

main()
  .catch((e) => {
    console.error("  ❌ فشلت تهيئة قاعدة البيانات:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
