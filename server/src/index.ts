import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import cors, { type CorsOptions } from "cors";

dotenv.config();

// Imported after dotenv.config() on purpose: these modules read process.env
// (DATABASE_URL, JWT_SECRET, …) the moment they are evaluated.
import { ensureDataDir } from "./db";
import { registerJobs } from "./jobs";
import { initRealtime } from "./realtime";
import routes from "./routes";

const app = express();
const PORT = Number(process.env.PORT) || 4000;

// 0.0.0.0, not localhost: the teacher's phone reaches the API over the wifi.
const HOST = process.env.HOST?.trim() || "0.0.0.0";

// SQLite will not create a missing directory — make sure server/data exists.
ensureDataDir();

app.disable("x-powered-by");

// One proxy hop, not `true`: on Render / Fly.io the TLS terminator sits in
// front of this process and appends the caller to `X-Forwarded-For`, so
// without this every audit entry would record the load balancer's address
// instead of the teacher's. `1` trusts only that last hop — with `true`
// anyone could prepend a fake address to the header and choose what the log
// says. On the LAN there is no proxy and no such header, so nothing changes.
app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ───────────────────────────── CORS ───────────────────────────────
/**
 * Auth is a Bearer token, so the browser must be allowed to send the
 * `Authorization` header (it is not on the CORS-safelist).
 *
 * Allowed origins are the CORS_ORIGINS list plus three families we always
 * accept:
 *  • `capacitor://…` — the Android WebView shell,
 *  • localhost and private-LAN addresses — Vite on the teacher's laptop, and a
 *    phone opening http://192.168.x.x:4000 on the same wifi,
 *  • this server's own public home, `https://*.onrender.com` and
 *    `https://*.fly.dev`, so a fresh deploy works before anyone remembers to
 *    fill in CORS_ORIGINS.
 * Anything else simply gets no CORS headers back (never a 500).
 */
const CONFIGURED_ORIGINS = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LAN_ORIGIN =
  /^https?:\/\/(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(:\d+)?$/i;

/**
 * The two hosts this server is deployed to: `https://mr-ahmed.onrender.com`,
 * `https://mr-ahmed.fly.dev` (see render.yaml / fly.toml).
 *
 * Anchored at both ends and https-only on purpose: `https://onrender.com.evil.net`
 * and `http://…onrender.com` are both rejected, and an Origin header never
 * carries a path, so there is nothing after the host to match.
 */
const HOSTED_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(onrender\.com|fly\.dev)$/i;

function isAllowedOrigin(origin: string): boolean {
  const clean = origin.replace(/\/$/, "");
  if (CONFIGURED_ORIGINS.includes(clean)) return true;
  if (clean.toLowerCase().startsWith("capacitor://")) return true;
  if (HOSTED_ORIGIN.test(clean)) return true;
  return LOCAL_ORIGIN.test(clean) || LAN_ORIGIN.test(clean);
}

const corsOptions: CorsOptions = {
  // No Origin header at all: curl, a same-origin request, or the WebView
  // loading the bundled files — all legitimate.
  origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)),
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ───────────────────────────── Health ─────────────────────────────
// Public on purpose: the Android app pings it to find the server before anyone
// has logged in.
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// ───────────────────────────── API ────────────────────────────────
app.use("/api", routes);

// Unknown API path — answer with JSON, never with the SPA shell.
app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: "المسار غير موجود" });
});

// ──────────────────── Production static serving ───────────────────
const WEB_DIST = path.join(__dirname, "../../web/dist");

if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));

  // SPA fallback — deliberately skips /api so API 404s stay JSON.
  app.get("*", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });
}

// ────────────────────── Centralised errors ────────────────────────
type HttpError = { status?: number; statusCode?: number; message?: string };

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const e = (err ?? {}) as HttpError;
  const status = e.status ?? e.statusCode ?? 500;
  const message =
    status < 500 && e.message ? e.message : "حدث خطأ في الخادم، برجاء المحاولة مرة أخرى";

  // Log the full error server-side; never send a stack trace to the client.
  console.error("[خطأ]", err);
  res.status(status).json({ error: message });
});

// ───────────────────────────── Boot ───────────────────────────────

/** Every http://<lan-ip>:PORT this machine can be reached at. */
function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const net of addresses ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      urls.push(`http://${net.address}:${port}`);
    }
  }
  return urls;
}

// Socket.IO shares this server, so the app is wrapped rather than listened to
// directly — and realtime must be attached before the first connection.
const httpServer = http.createServer(app);

let realtimeReady = false;
try {
  initRealtime(httpServer);
  realtimeReady = true;
} catch (e) {
  console.error("  ⚠️  تعذّر تفعيل التحديثات الفورية:", e);
}

httpServer.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log("");
  console.log("  ╭──────────────────────────────────────────────╮");
  console.log("  │        نظام إدارة الطلاب والتنبيهات          │");
  console.log("  ╰──────────────────────────────────────────────╯");
  console.log(`  ✅ الخادم يعمل على: ${url}`);
  console.log(`  🩺 فحص الحالة:     ${url}/api/health`);
  for (const lan of lanUrls(PORT)) {
    console.log(`  📱 من الشبكة المحلية: ${lan}`);
  }
  if (fs.existsSync(WEB_DIST)) {
    console.log(`  🖥️  الواجهة تُقدَّم من: ${WEB_DIST}`);
  } else {
    console.log("  🖥️  واجهة التطوير:   http://localhost:5173");
  }
  console.log(
    realtimeReady ? "  🔌 التحديثات الفورية مفعّلة" : "  🔌 التحديثات الفورية معطّلة",
  );
  console.log("");

  try {
    registerJobs();
    console.log("  ⏰ تم تفعيل المهام المجدولة");
  } catch (e) {
    console.error("  ⚠️  تعذّر تفعيل المهام المجدولة:", e);
  }
  console.log("");
});

export { httpServer };
export default app;
