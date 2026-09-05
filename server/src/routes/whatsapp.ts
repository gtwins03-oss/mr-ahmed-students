/**
 * /api/whatsapp — linking the teacher's OWN WhatsApp account, WhatsApp-Web style.
 *
 * The flow, end to end:
 *   1. POST /link      the teacher pastes his Green API `idInstance` + `apiTokenInstance`
 *                      (one instance = one WhatsApp number). They are **probed first**,
 *                      and only if the gateway answers are they stored in
 *                      `settings.providerConfig` and the provider switched to GREEN_API.
 *   2. GET  /qr        the linking screen polls this every ~3 s and shows the PNG.
 *                      WhatsApp rotates the code about every 20 s — see ../messaging/whatsapp-link.
 *   3. …scan…          the phone scans it; the next poll answers `already-linked`, the
 *                      number behind the session is discovered and stored in
 *                      `settings.tutorWhatsapp`, and `whatsappLinkedAt` is stamped.
 *   4. from then on    `drainOutbox()` sends every parent notification from that number,
 *                      and templates can print it as {{teacher_whatsapp}}.
 *   5. POST /unlink    logs the session out and clears the credentials again.
 *
 * ── Two rules this file exists to enforce ──
 *
 * **No secret ever leaves.** `apiTokenInstance` is write-only: it goes in through
 * POST /link and is never echoed back by any endpoint here. GET /status answers
 * `configured: true` instead, which is all the UI needs to know.
 *
 * **A poll is not a write.** GET /qr runs every three seconds; `saveWhatsappLink()`
 * persists only what actually changed, and the audit line + `emitChange("Setting")`
 * fire only when something did — except for /link and /unlink, which are deliberate
 * acts by the teacher and are always recorded.
 *
 * Mounted by routes/index.ts, below its blanket `router.use(requireAuth)`. The guard is
 * repeated here anyway (it is a no-op once `req.user` is set) so this router stays closed
 * whatever the mount order becomes — the same belt-and-braces posture as /users and
 * /audit. Assistants may link a number like any other data change; nothing here is
 * OWNER-only.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { Setting } from "@prisma/client";
import { z } from "zod";

import { badRequest, parseBody } from "../lib/validate";
import {
  hasGreenApiCredentials,
  parseGreenApiConfig,
  type GreenApiConfig,
} from "../messaging/green-api";
import {
  getLinkedPhone,
  getQr,
  getState,
  logout,
  toWhatsappState,
  whatsappStateAr,
  type WhatsappState,
} from "../messaging/whatsapp-link";
import { requireAuth } from "../middleware/auth";
import { emitChange } from "../realtime";
import { logAudit } from "../services/audit.service";
import {
  getSettings,
  parseProviderConfig,
  redactProviderConfig,
  saveWhatsappLink,
  type WhatsappLinkPatch,
} from "../services/settings.service";

const router = Router();

router.use(requireAuth);

const NOT_CONFIGURED =
  "لم يتم إدخال بيانات ربط واتساب بعد — أدخل رقم النسخة ورمز الوصول أولاً";

// ──────────────────────────────── The status DTO ───────────────────────────────

/** What GET /status, POST /link, POST /unlink and POST /refresh all answer with. */
export type WhatsappStatus = {
  /** The active messaging provider: WA_LINK | GREEN_API | TWILIO. */
  provider: string;
  state: WhatsappState;
  /** The state in Arabic, ready to print. */
  stateLabel: string;
  /** The teacher's own sending number, E.164, or "" while unlinked. */
  phone: string;
  linkedAt: Date | null;
  /** True when credentials are stored — the token itself is never returned. */
  configured: boolean;
  /** Arabic diagnostic from the last live probe. Never carries a secret. */
  warning?: string;
};

/** The stored credentials, or null when either half is missing. */
const configOf = (settings: Setting): GreenApiConfig | null =>
  parseGreenApiConfig(parseProviderConfig(settings));

function toStatus(settings: Setting, warning?: string): WhatsappStatus {
  const state = toWhatsappState(settings.whatsappState);
  return {
    provider: settings.provider,
    state,
    stateLabel: whatsappStateAr(state),
    phone: settings.tutorWhatsapp,
    linkedAt: settings.whatsappLinkedAt,
    configured: hasGreenApiCredentials(parseProviderConfig(settings)),
    ...(warning ? { warning } : {}),
  };
}

// ──────────────────────────── Write + audit + realtime ─────────────────────────

/**
 * Persists a link patch and records it.
 *
 * With an explicit `summary` the line is always written — /link and /unlink are
 * things the teacher *did*, and the log should say so even if the values happened
 * to be identical. Without one, only a real change is worth a sentence, which is
 * what keeps the 3-second QR poll out of the audit trail.
 */
async function persist(
  req: Request,
  patch: WhatsappLinkPatch,
  summary?: string,
): Promise<Setting> {
  const { settings, changes } = await saveWhatsappLink(patch);

  const line = summary ?? (changes.length > 0 ? changes.join("، ") : "");
  if (!line) return settings;

  await logAudit(req, {
    action: "SETTINGS",
    entity: "Setting",
    entityId: String(settings.id),
    summary: line,
    after: {
      provider: settings.provider,
      providerConfig: redactProviderConfig(parseProviderConfig(settings)),
      tutorWhatsapp: settings.tutorWhatsapp,
      whatsappState: settings.whatsappState,
      whatsappLinkedAt: settings.whatsappLinkedAt,
    },
  });
  emitChange("Setting");

  return settings;
}

/**
 * The columns a freshly-observed link state implies.
 *
 * On AUTHORIZED the number behind the session is discovered and stored as the
 * sender, and `whatsappLinkedAt` is stamped — but only when the account has just
 * *become* linked (or was never stamped). Re-stamping on every refresh would turn
 * «آخر مرة تأكّد فيها الربط» into «آخر مرة ضغطنا فيها تحديث».
 */
async function patchForState(
  settings: Setting,
  cfg: GreenApiConfig,
  state: WhatsappState,
): Promise<WhatsappLinkPatch> {
  const patch: WhatsappLinkPatch = { whatsappState: state };
  if (state !== "AUTHORIZED") return patch;

  const phone = await getLinkedPhone(cfg);
  // A failed lookup must not wipe a number we already know.
  if (phone) patch.tutorWhatsapp = phone;
  if (settings.whatsappState !== "AUTHORIZED" || !settings.whatsappLinkedAt) {
    patch.whatsappLinkedAt = new Date();
  }
  return patch;
}

/** Asks Green API where the session stands and writes the answer down. */
async function probeAndPersist(
  req: Request,
  settings: Setting,
  cfg: GreenApiConfig,
): Promise<{ settings: Setting; warning?: string }> {
  const probe = await getState(cfg);
  const state: WhatsappState = probe.ok ? probe.state : "ERROR";
  const saved = await persist(req, await patchForState(settings, cfg, state));
  return probe.ok ? { settings: saved } : { settings: saved, warning: probe.error };
}

// ───────────────────────────────────── Reads ───────────────────────────────────

/** The stored status — cheap, no call to Green API. Use /refresh to re-probe. */
router.get("/status", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(toStatus(await getSettings()));
  } catch (err) {
    next(err);
  }
});

/**
 * The polling endpoint: the linking screen calls this every ~3 seconds.
 *
 * Always answers 200 with a `kind` — a screen that polls must not fill the console
 * with 4xx just because the teacher has not pasted his credentials yet.
 */
router.get("/qr", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await getSettings();
    const cfg = configOf(settings);
    if (!cfg) {
      res.json({ kind: "error", error: NOT_CONFIGURED });
      return;
    }

    const result = await getQr(cfg);

    if (result.kind === "qr") {
      // The code is on screen and waiting for a phone — say so once, not every poll.
      await persist(req, { whatsappState: "QR_PENDING" });
      res.json({ kind: "qr", pngDataUri: result.pngDataUri });
      return;
    }

    if (result.kind === "already-linked") {
      // Scanned. Discover the number and stamp the link before answering, so the
      // status the UI fetches next is already the finished one.
      await probeAndPersist(req, settings, cfg);
      res.json({ kind: "already-linked" });
      return;
    }

    res.json({ kind: "error", error: result.error });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────── Writes ───────────────────────────────────

const linkSchema = z.object({
  // green-api.com prints the instance id as a number; accept either shape.
  idInstance: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((s) => /^\d{4,32}$/.test(s), "رقم النسخة (idInstance) يجب أن يكون أرقاماً"),
  apiTokenInstance: z
    .string()
    .trim()
    .min(8, "رمز الوصول (apiTokenInstance) غير مكتمل")
    .max(200, "رمز الوصول (apiTokenInstance) طويل جداً"),
  // Busy instances get their own host, e.g. https://7103.api.greenapi.com.
  apiUrl: z
    .string()
    .trim()
    .max(200)
    .regex(/^https?:\/\/\S+$/, "عنوان الخادم يجب أن يبدأ بـ http:// أو https://")
    .optional(),
});

/**
 * Verifies the credentials against Green API, and only then saves them and switches
 * the provider — so the screen can jump straight to «امسح رمز QR» or «مرتبط بالفعل».
 *
 * ⚠️ **Probe first, write second.** An earlier version stored the keys and flipped
 * `provider` to GREEN_API *before* the probe, which meant a typo in the instance id —
 * or a paste of somebody else's expired token — left the whole system pointed at a
 * gateway that answers 401 to everything: `drainOutbox()` would then fail every parent
 * notification instead of falling back to the wa.me links that do work. Credentials
 * that cannot be reached are not saved at all; the settings row is left exactly as it
 * was and the teacher gets the Arabic reason back with a 400.
 *
 * A reachable-but-unlinked instance (NOT_AUTHORIZED — the normal state of a brand-new
 * one) *is* saved: that is precisely the case the QR screen exists for.
 *
 * The rest of `providerConfig` (a Twilio account the teacher configured earlier, a
 * custom `apiUrl`) is preserved — only the Green API keys are written.
 */
router.post("/link", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { idInstance, apiTokenInstance, apiUrl } = parseBody(linkSchema, req);
    const cfg: GreenApiConfig = { idInstance, apiTokenInstance, ...(apiUrl ? { apiUrl } : {}) };

    const settings = await getSettings();

    const probe = await getState(cfg);
    if (!probe.ok) {
      // Nothing was written — but the attempt itself belongs in «سجل النشاط»,
      // because "why did WhatsApp stop working" is answered by seeing it there.
      await logAudit(req, {
        action: "SETTINGS",
        entity: "Setting",
        entityId: String(settings.id),
        summary: `فشلت محاولة ربط حساب واتساب (رقم النسخة ${idInstance}): ${probe.error}`,
        after: {
          idInstance,
          // Unchanged, and said out loud so the log shows the app did not switch.
          provider: settings.provider,
          saved: false,
        },
      });
      throw badRequest(probe.error);
    }

    const providerConfig: Record<string, unknown> = {
      ...parseProviderConfig(settings),
      idInstance,
      apiTokenInstance,
      ...(apiUrl ? { apiUrl } : {}),
    };

    const saved = await persist(
      req,
      {
        ...(await patchForState(settings, cfg, probe.state)),
        provider: "GREEN_API",
        providerConfig,
      },
      "ربط حساب واتساب جديد",
    );

    res.json(toStatus(saved));
  } catch (err) {
    next(err);
  }
});

/**
 * Logs the session out at Green API and forgets it here: credentials cleared, provider
 * back to the manual wa.me links, state UNKNOWN, sending number blank.
 *
 * The local clean-up happens even when the remote logout fails — the teacher asked to
 * disconnect, and leaving a token behind because green-api.com was unreachable would be
 * the wrong answer. The failure comes back as `warning`.
 */
router.post("/unlink", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await getSettings();
    const cfg = configOf(settings);

    let warning: string | undefined;
    if (cfg) {
      const result = await logout(cfg);
      if (!result.ok) warning = result.error;
    }

    const providerConfig = parseProviderConfig(settings);
    delete providerConfig.idInstance;
    delete providerConfig.apiTokenInstance;

    const phone = settings.tutorWhatsapp;
    const saved = await persist(
      req,
      {
        provider: "WA_LINK",
        providerConfig,
        tutorWhatsapp: "",
        whatsappState: "UNKNOWN",
        whatsappLinkedAt: null,
      },
      phone ? `فصل حساب واتساب المرتبط بالرقم ${phone}` : "فصل حساب واتساب",
    );

    res.json(toStatus(saved, warning));
  } catch (err) {
    next(err);
  }
});

/** Re-probes the live session and persists what it finds — «تحديث الحالة». */
router.post("/refresh", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await getSettings();
    const cfg = configOf(settings);
    if (!cfg) {
      res.json(toStatus(settings, NOT_CONFIGURED));
      return;
    }

    const probed = await probeAndPersist(req, settings, cfg);
    res.json(toStatus(probed.settings, probed.warning));
  } catch (err) {
    next(err);
  }
});

export default router;
