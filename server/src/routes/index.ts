/**
 * The whole REST surface, mounted under /api by server/src/index.ts.
 *
 * Architectural rule (docs/01-architecture.md §1.4): routes validate input and
 * delegate; only services enqueue messages.
 *
 * Access model — exactly two roles:
 *   OWNER     — الأستاذ أحمد: everything below, plus /users and /audit.
 *   ASSISTANT — everything *except* /users and /audit. Assistants are trusted
 *               with all the data (students, classes, attendance, grades,
 *               messages, templates, settings); they are simply never shown
 *               the audit trail or the account list — the nav item is absent
 *               in the UI and `requireOwner` answers 403 there.
 *
 * ───────────────────────── Rollout, staged by mount point ─────────────────
 *
 * `/users` and `/audit` are guarded **twice over**: each of those routers opens
 * with its own `router.use(requireAuth, requireOwner)`, so the audit trail and
 * the account list are unreachable without an OWNER token no matter what
 * happens in this file.
 *
 * The data routers are guarded **here**, by the single `router.use(requireAuth)`
 * below. It sits above every mount except `/auth`, so an anonymous request to
 * /api/anything — including a path that matches no route at all — gets 401
 * rather than a hint about which endpoints exist.
 *
 * That guard is what web/ now expects: it ships a login screen
 * (pages/Login.tsx + auth/AuthContext.tsx) and its fetch wrapper
 * (web/src/api/client.ts) attaches `Authorization: Bearer <token>` to every
 * request, dropping the token and bouncing back to /login on a 401.
 *
 * Never weaken the guards in ../middleware/auth to make a page work — stage any
 * future rollout by mount point, exactly as this file does.
 */
import { Router } from "express";

import { requireAuth } from "../middleware/auth";
import assessments from "./assessments";
import audit from "./audit";
import auth from "./auth";
import classes from "./classes";
import dashboard from "./dashboard";
import messages from "./messages";
import reports from "./reports";
import sessions from "./sessions";
import settings from "./settings";
import students from "./students";
import templates from "./templates";
import users from "./users";
import whatsapp from "./whatsapp";

const router = Router();

// ─────────────────────────────── Public ────────────────────────────────

router.use("/auth", auth);

// ───────────────────── Data routes (OWNER or ASSISTANT) ────────────────
//
// Everything below this line needs a token — including unmatched paths, so an
// anonymous request to /api/anything gets 401 rather than a hint about which
// endpoints exist. ASSISTANTs pass it exactly like the OWNER does: they are
// trusted with all the data, and only /users and /audit are closed to them.

router.use(requireAuth);

router.use("/students", students);
router.use("/classes", classes);
router.use("/sessions", sessions);
router.use("/assessments", assessments);
router.use("/messages", messages);
router.use("/templates", templates);
router.use("/settings", settings);
router.use("/whatsapp", whatsapp);
router.use("/reports", reports);
router.use("/dashboard", dashboard);

// ────────────────────────────── OWNER only ─────────────────────────────
//
// No guard is repeated here: both routers begin with
// `router.use(requireAuth, requireOwner)`, so they stay locked whatever this
// file does — the guarantee does not depend on the mount order above.

router.use("/users", users);
router.use("/audit", audit);

export default router;
