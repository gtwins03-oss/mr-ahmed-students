/**
 * Grade entry, and the low-score rule (docs/02-messaging.md §2.7).
 *
 * A blank score is `null` — "did not sit the test". It is excluded from every
 * average and never triggers an alert.
 *
 * Like the attendance grid, the sheet is audited per *changed* student: the old
 * scores are read before the upsert so the log can say «من ٤٥ إلى ٧٠», and a
 * re-save with one correction writes exactly one line.
 */
import type { Request } from "express";

import { prisma } from "../db";
import { arNum } from "../lib/arabic";
import { badRequest, notFound } from "../lib/validate";
import { enqueueMessage } from "../messaging/outbox";
import { arDate } from "../messaging/template";
import { emitChange } from "../realtime";
import { logAudit } from "./audit.service";
import { getSettings } from "./settings.service";

export type GradeEntry = {
  studentId: string;
  score: number | null;
  note?: string | null;
};

export type SaveGradesResult = { saved: number; queued: number };

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

  if (list.length === 0) return { saved: 0, queued: 0 };

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

  if (!settings.autoSendLowGrade) return { saved: list.length, queued: 0 };

  let queued = 0;
  for (const e of list) {
    if (e.score === null) continue; // absent from the test ≠ a low grade
    if (assessment.maxScore <= 0) continue; // guard against a divide-by-zero

    const pct = (e.score / assessment.maxScore) * 100;
    if (pct >= settings.lowGradeThreshold) continue;

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

  return { saved: list.length, queued };
}
