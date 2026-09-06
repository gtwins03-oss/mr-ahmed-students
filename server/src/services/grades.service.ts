/**
 * Grade entry, and the low-score rule (docs/02-messaging.md §2.7).
 *
 * A blank score is `null` — "did not sit the test". It is excluded from every
 * average and never triggers an alert.
 *
 * Editing a score back up to the threshold — or blanking it — *withdraws* the
 * alert it raised (`cancelPending`), so a mistyped mark can never leave a queued
 * message telling a parent about a grade their child never got.
 *
 * Like the attendance grid, the sheet is audited per *changed* student: the old
 * scores are read before the upsert so the log can say «من ٤٥ إلى ٧٠», and a
 * re-save with one correction writes exactly one line.
 */
import type { Request } from "express";

import { prisma } from "../db";
import { arNum } from "../lib/arabic";
import { badRequest, notFound } from "../lib/validate";
import { cancelPending, enqueueMessage, type SentAlready } from "../messaging/outbox";
import { arDate } from "../messaging/template";
import { emitChange } from "../realtime";
import { logAudit } from "./audit.service";
import { getSettings } from "./settings.service";

export type GradeEntry = {
  studentId: string;
  score: number | null;
  note?: string | null;
};

export type SaveGradesResult = {
  saved: number;
  queued: number;
  /** Queued alerts withdrawn because the score that raised them was corrected. */
  cancelled: number;
  /** Alerts that had already gone out — a correction cannot unsend them. */
  sentAlready: SentAlready[];
};

export async function saveGrades(
  assessmentId: string,
  entries: GradeEntry[],
  req: Request | null = null,
): Promise<SaveGradesResult> {
  // Last write wins if the client sent the same student twice.
  const unique = new Map<string, GradeEntry>();
  for (const e of entries) unique.set(e.studentId, e);
  const list = [...unique.values()];

  const [settings, assessment] = await Promise.all([
    getSettings(),
    prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: { classGroup: true },
    }),
  ]);
  if (!assessment) throw notFound("الاختبار غير موجود");

  if (list.length === 0) return { saved: 0, queued: 0, cancelled: 0, sentAlready: [] };

  const overMax = list.find((e) => e.score !== null && e.score > assessment.maxScore);
  if (overMax) {
    throw badRequest(`الدرجة يجب ألا تتجاوز الدرجة العظمى (${assessment.maxScore})`);
  }

  const studentIds = list.map((e) => e.studentId);

  // Names come back with the existence check — every audit line needs them.
  const known = await prisma.student.findMany({
    where: { id: { in: studentIds } },
    select: { id: true, name: true },
  });
  if (known.length !== list.length) {
    throw badRequest("بعض الطلاب في القائمة غير موجودين");
  }
  const nameOf = new Map(known.map((s) => [s.id, s.name]));

  // The scores as they stand *now* — read before the write so "من ٤٥ إلى ٧٠"
  // describes what really happened.
  const previousRows = await prisma.grade.findMany({
    where: { assessmentId, studentId: { in: studentIds } },
  });
  const previous = new Map(previousRows.map((g) => [g.studentId, g]));

  const rows = await prisma.$transaction(
    list.map((e) =>
      prisma.grade.upsert({
        where: { assessmentId_studentId: { assessmentId, studentId: e.studentId } },
        create: {
          assessmentId,
          studentId: e.studentId,
          score: e.score,
          note: e.note ?? null,
        },
        update: { score: e.score, note: e.note ?? null },
      }),
    ),
  );

  // One line per student whose score actually moved — never one per row sent.
  const maxScoreAr = arNum(assessment.maxScore);
  let changed = 0;

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const prev = previous.get(e.studentId);
    const name = nameOf.get(e.studentId) ?? "طالب";
    const note = e.note ?? null;
    const prevScore = prev?.score ?? null;

    let summary: string | null = null;
    if (prevScore !== e.score) {
      if (e.score === null) {
        summary = `مسح درجة "${name}" في ${assessment.title}`;
      } else if (prevScore === null) {
        summary = `سجّل درجة "${name}": ${arNum(e.score)} من ${maxScoreAr} في ${assessment.title}`;
      } else {
        summary = `عدّل درجة "${name}" من ${arNum(prevScore)} إلى ${arNum(e.score)} في ${assessment.title}`;
      }
    } else if ((prev?.note ?? null) !== note) {
      summary = note
        ? `أضاف ملاحظة على درجة "${name}" في ${assessment.title}: ${note}`
        : `مسح ملاحظة درجة "${name}" في ${assessment.title}`;
    }

    if (!summary) continue; // an untouched cell is not history
    changed += 1;

    await logAudit(req, {
      action: "GRADES",
      entity: "Grade",
      entityId: rows[i]?.id ?? null,
      summary,
      before: prev ? { score: prev.score, note: prev.note } : null,
      after: { score: e.score, note },
    });
  }

  if (changed > 0) emitChange("Grade");

  /**
   * Does this score deserve a «تنبيه مستوى»? Raising an alert and withdrawing
   * one have to be exact opposites of each other — asked twice, the two rules
   * drift and a corrected score gets queued and cancelled in the same save.
   *
   * A blank score is "did not sit the test", never a low grade, and a
   * non-positive max score cannot be turned into a percentage at all.
   */
  const isLow = (score: number | null): boolean =>
    score !== null &&
    assessment.maxScore > 0 &&
    (score / assessment.maxScore) * 100 < settings.lowGradeThreshold;

  // Withdraw the alert a correction just invalidated: a score edited up to (or
  // above) the threshold — or blanked — no longer describes a low grade, and a
  // queued «تنبيه مستوى» would tell the parent something that is not true.
  //
  // This runs before the `autoSendLowGrade` gate below on purpose: the alert may
  // well have been queued while that switch was still on, and turning it off
  // afterwards must not strand the message in the queue. Only a score that
  // actually moved withdraws anything, and a student with no previous row never
  // had an alert to withdraw.
  const stale = list.filter((e) => {
    const prev = previous.get(e.studentId);
    return prev !== undefined && prev.score !== e.score && !isLow(e.score);
  });

  let cancelled = 0;
  const sentAlready: SentAlready[] = [];

  if (stale.length > 0) {
    const dedupeKeyFor = (studentId: string): string =>
      `LOW_GRADE:${assessmentId}:${studentId}`;

    // One query answers "were these ever queued, and where are they now?".
    // `cancelPending()` alone cannot tell «لا يوجد ما يُلغى» apart from «فات
    // الأوان», and the second is the case the teacher has to hear about.
    const rows = await prisma.message.findMany({
      where: { dedupeKey: { in: stale.map((e) => dedupeKeyFor(e.studentId)) } },
      select: { dedupeKey: true, status: true },
    });
    const statusOf = new Map<string, string>();
    for (const row of rows) if (row.dedupeKey) statusOf.set(row.dedupeKey, row.status);

    for (const e of stale) {
      const dedupeKey = dedupeKeyFor(e.studentId);
      const status = statusOf.get(dedupeKey);

      if (status === "PENDING") {
        const row = await cancelPending(dedupeKey, "بعد تعديل الدرجة", req);
        if (row) cancelled += 1;
      } else if (status === "SENT") {
        // Impossible to withdraw — the parent already has it. Say so out loud
        // rather than letting the correction look complete.
        sentAlready.push({
          studentId: e.studentId,
          studentName: nameOf.get(e.studentId) ?? "طالب",
          templateKey: "LOW_GRADE",
        });
      }
    }
  }

  if (!settings.autoSendLowGrade) {
    return { saved: list.length, queued: 0, cancelled, sentAlready };
  }

  let queued = 0;
  for (const e of list) {
    if (e.score === null) continue; // absent from the test ≠ a low grade
    if (!isLow(e.score)) continue; // at or above the threshold — no alert

    const pct = (e.score / assessment.maxScore) * 100;

    const result = await enqueueMessage({
      studentId: e.studentId,
      templateKey: "LOW_GRADE",
      relatedType: "GRADE",
      relatedId: assessmentId,
      dedupeKey: `LOW_GRADE:${assessmentId}:${e.studentId}`,
      vars: {
        assessment_title: assessment.title,
        subject: assessment.classGroup.subject,
        class_name: assessment.classGroup.name,
        date_ar: arDate(assessment.date),
        score: e.score,
        max_score: assessment.maxScore,
        percentage: pct.toFixed(1),
      },
    });
    // Only a *new* row counts — re-saving the same sheet adds nothing.
    if (result?.created) queued += 1;
  }

  if (queued > 0) emitChange("Message");

  return { saved: list.length, queued, cancelled, sentAlready };
}
