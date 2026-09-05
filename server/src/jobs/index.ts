/**
 * In-process schedule (node-cron). One long-lived Node process hosts the API,
 * the outbox dispatcher and these jobs — which is exactly why the app is not
 * serverless (docs/01-architecture.md §1.2).
 *
 *   06:00 daily   → materialise today's sessions from the weekly schedule
 *   every 2 min   → drain the outbox (no-op on Tier 0 / during quiet hours)
 *   18:00 on the 1st → queue last month's parent reports
 *   02:30 daily   → copy the SQLite file into backups/, keeping the newest 30
 *
 * Every job is wrapped: a failure is logged and the process keeps running.
 */
import fs from "fs";
import path from "path";
import cron from "node-cron";

import { DATA_DIR, prisma } from "../db";
import { drainOutbox } from "../messaging/outbox";
import { queueMonthlyReports } from "../services/reports.service";
import { ensureSessions, previousMonth, todayISO } from "../services/sessions.service";

const KEEP_BACKUPS = 30;
const BACKUP_DIR = path.resolve(DATA_DIR, "..", "backups");
const PRISMA_DIR = path.resolve(DATA_DIR, "..", "prisma");
const BACKUP_FILE = /^tutor-\d{4}-\d{2}-\d{2}\.db$/;

/** Never let a scheduled job take the server down. */
async function safely<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
  try {
    return await task();
  } catch (err) {
    console.error(`  ⚠️  فشلت المهمة المجدولة «${label}»:`, err);
    return undefined;
  }
}

// ───────────────────────────── The jobs ────────────────────────────────

export async function buildTodaySessions(): Promise<void> {
  const date = todayISO();
  const created = await ensureSessions(date);
  if (created > 0) console.log(`  📅 تم إنشاء ${created} حصة ليوم ${date}`);
}

export async function dispatchOutbox(): Promise<void> {
  const { processed, sent, failed } = await drainOutbox();

  // Runs every two minutes, and on Tier 0 / during quiet hours it does nothing
  // at all — so only speak up when a message actually moved.
  if (processed > 0) {
    console.log(`  📨 قائمة الإرسال: ${sent} مُرسَلة، ${failed} فاشلة`);
  }
}

export async function queueLastMonthReports(): Promise<void> {
  const month = previousMonth();
  const { queued } = await queueMonthlyReports(month);
  console.log(`  📊 تم تجهيز ${queued} تقرير شهري عن ${month}`);
}

/**
 * The SQLite file behind DATABASE_URL, or null when the database is not a file
 * at all (`postgresql://…` after `npm run db:use-postgres`). Relative paths
 * resolve against prisma/, exactly as Prisma resolves them.
 */
function sqliteFile(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return path.join(DATA_DIR, "tutor.db"); // the .env default
  if (!url.startsWith("file:")) return null;

  const raw = url.slice("file:".length);
  return path.isAbsolute(raw) ? raw : path.resolve(PRISMA_DIR, raw);
}

export async function backupDatabase(): Promise<void> {
  // On PostgreSQL the host takes the backups — skip quietly instead of failing
  // at 02:30 every night.
  const source = sqliteFile();
  if (!source) {
    console.log("  💾 تم تخطّي النسخ الاحتياطي — قاعدة البيانات ليست SQLite");
    return;
  }

  if (!fs.existsSync(source)) {
    console.warn(`  ⚠️  لم يتم العثور على قاعدة البيانات للنسخ الاحتياطي: ${source}`);
    return;
  }

  // Fold any write-ahead log back into the main file so the copy is complete.
  try {
    await prisma.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    /* journal mode may not be WAL — the plain copy is still valid */
  }

  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, `tutor-${todayISO()}.db`);
  await fs.promises.copyFile(source, target);

  // ISO names sort chronologically, so newest-first is a plain reverse sort.
  const files = (await fs.promises.readdir(BACKUP_DIR))
    .filter((f) => BACKUP_FILE.test(f))
    .sort()
    .reverse();

  for (const stale of files.slice(KEEP_BACKUPS)) {
    await fs.promises.unlink(path.join(BACKUP_DIR, stale)).catch(() => undefined);
  }

  console.log(`  💾 نسخة احتياطية: ${path.basename(target)} (يُحتفظ بأحدث ${KEEP_BACKUPS})`);
}

// ─────────────────────────── Registration ──────────────────────────────

export function registerJobs(): void {
  // 06:00 — today's sessions, before the teacher opens the app.
  cron.schedule("0 6 * * *", () => {
    void safely("إنشاء حصص اليوم", buildTodaySessions);
  });

  // Every 2 minutes — drain the outbox (returns immediately on Tier 0).
  cron.schedule("*/2 * * * *", () => {
    void safely("تفريغ قائمة الإرسال", dispatchOutbox);
  });

  // 18:00 on the 1st — last month's reports for every active student.
  cron.schedule("0 18 1 * *", () => {
    void safely("التقارير الشهرية", queueLastMonthReports);
  });

  // 02:30 — nightly SQLite backup.
  cron.schedule("30 2 * * *", () => {
    void safely("النسخ الاحتياطي", backupDatabase);
  });

  // And once at boot: the laptop may well have been closed at 06:00.
  void safely("إنشاء حصص اليوم", buildTodaySessions);
}

export default registerJobs;
