/**
 * /api/settings — the single settings row.
 *
 * `providerConfig` is stored as a JSON string but always exposed as an object,
 * so the settings screen can bind credential fields directly.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";

import { parseBody } from "../lib/validate";
import { testProvider } from "../messaging";
import { logAudit } from "../services/audit.service";
import {
  getSettings,
  PROVIDER_AR,
  toSettingsDto,
  updateSettings,
} from "../services/settings.service";

const router = Router();

router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(toSettingsDto(await getSettings()));
  } catch (err) {
    next(err);
  }
});

router.put("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    // updateSettings validates with zod, drops unknown keys, and owns the audit
    // line — it is the only place that can see which fields actually moved.
    res.json(toSettingsDto(await updateSettings(req.body, req)));
  } catch (err) {
    next(err);
  }
});

// PATCH behaves identically — both verbs take a partial patch.
router.patch("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(toSettingsDto(await updateSettings(req.body, req)));
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────── Test message ─────────────────────────────

const testSchema = z.object({
  phone: z.string().trim().min(6, "رقم الهاتف مطلوب").max(30),
});

/**
 * «اختبار الإرسال» — proves the configured credentials actually work, without
 * touching the outbox. On a manual provider (Tier 0) there is nothing to send,
 * so the result carries a `waLink` for the UI to open instead.
 */
router.post("/test", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone } = parseBody(testSchema, req);
    const settings = await getSettings();
    const result = await testProvider(settings, phone);

    // On Tier 0 nothing was actually sent — the UI opens a wa.me link — so the
    // log must not claim otherwise.
    const provider = PROVIDER_AR[settings.provider] ?? settings.provider;
    const target = `عبر ${provider} إلى الرقم ${result.toPhone || phone}`;

    await logAudit(req, {
      action: "MESSAGE",
      entity: "Setting",
      entityId: String(settings.id),
      summary: !result.ok
        ? `فشلت رسالة الاختبار ${target}: ${result.message}`
        : result.autonomous
          ? `أرسل رسالة اختبار ${target}`
          : `جهّز رسالة اختبار ${target}`,
      after: { provider: result.provider, toPhone: result.toPhone, ok: result.ok },
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
