# syntax=docker/dockerfile:1
#
# ─────────────────────────────────────────────────────────────────────────────
# One image = the whole system.
#
# The server is a single Node process that hosts the API, the cron jobs and the
# messaging outbox, and *also* serves the built React SPA when it finds it. It
# looks for the SPA at exactly one place — server/src/index.ts:
#
#     const WEB_DIST = path.join(__dirname, "../../web/dist");
#
# With the compiled server at /app/server/dist, `__dirname/../../web/dist`
# resolves to **/app/web/dist**. The final stage below reproduces that layout
# on purpose; moving either directory silently turns the SPA off (the app would
# still answer /api/* but the browser would get a 404 on "/").
#
# Build from the project root, so the context contains both workspaces:
#
#     docker build -t mr-ahmed .
#     docker run -p 4000:4000 --env-file server/.env mr-ahmed
#
# Deployment recipes: render.yaml · fly.toml · docs/05-النشر-والموبايل.md
# ─────────────────────────────────────────────────────────────────────────────


# ═══════════════════ Stage 1 — the Arabic RTL front-end ══════════════════════
FROM node:22-alpine AS web-build

WORKDIR /app/web

# Dependencies first: this layer is cached until package-lock.json changes.
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

# Only what `tsc -b && vite build` actually reads.
#   • tsconfig.node.json includes capacitor.config.ts — omit that file and the
#     type-check step fails before Vite ever runs.
#   • web/.env.production is deliberately NOT copied. It pins VITE_API_BASE to
#     the teacher's LAN address for APK builds; inside this image the SPA is
#     served by the very server it calls, and an absent value means "same
#     origin" (web/src/lib/apiBase.ts) — which is the correct answer here.
COPY web/tsconfig.json web/tsconfig.app.json web/tsconfig.node.json ./
COPY web/vite.config.ts web/capacitor.config.ts web/index.html ./
COPY web/src ./src

RUN npm run build


# ═══════════════════ Stage 2 — compile the CommonJS server ═══════════════════
FROM node:22-alpine AS server-build

WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund

# `prisma generate` before `tsc`: the compiler needs the generated types for
# every model, otherwise the build fails on the first `prisma.student.…`.
COPY server/prisma ./prisma
RUN npx prisma generate

COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build


# ═══════════════════════════ Stage 3 — runtime ═══════════════════════════════
FROM node:22-alpine AS runtime

#   openssl — Prisma's query engine links against it on musl.
#   tzdata  — node-cron reads the *system* clock and the schedules are written
#             in the teacher's local time (06:00 today's sessions, 02:30 backup,
#             quiet hours in the messaging outbox). A container defaults to UTC,
#             which would fire everything two hours early; TZ fixes that and can
#             still be overridden by the host's environment.
#   tini    — PID 1 that forwards SIGTERM. Node does not reap or handle signals
#             as PID 1, so without it every redeploy waits for the 10s SIGKILL.
RUN apk add --no-cache openssl tzdata tini

ENV NODE_ENV=production
ENV TZ=Africa/Cairo

WORKDIR /app/server

# Runtime dependencies only — no typescript/tsx/@types in the shipped image.
#
# The Prisma CLI is installed globally instead, because the start command runs
# `prisma db push` and the CLI is a devDependency that --omit=dev removes.
# ⚠️ Keep this version equal to `prisma`/`@prisma/client` in server/package.json
#    (5.22.0); a CLI newer than the client generates a client it cannot load.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm install --global --no-audit --no-fund prisma@5.22.0 \
 && npm cache clean --force

# Generated inside the final image on purpose: the engine binary is picked for
# *this* platform (linux-musl-openssl-3.0.x) rather than the builder's, and a
# fresh `npm ci` above would have wiped anything copied in beforehand.
COPY server/prisma ./prisma
RUN prisma generate

COPY --from=server-build /app/server/dist ./dist
COPY --from=web-build    /app/web/dist    /app/web/dist

# ensureDataDir() runs at boot and creates server/data; on Postgres it stays
# empty, but the non-root user still has to be able to make it. backups/ is
# there for the same reason (the nightly job skips itself on Postgres).
RUN mkdir -p /app/server/data /app/server/backups \
 && chown -R node:node /app

# Never run the API as root: `node` (uid 1000) ships with the base image.
USER node

EXPOSE 4000

# Container-local probe, so it keeps working whatever port the host injects.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD wget --quiet --spider "http://127.0.0.1:${PORT:-4000}/api/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]

# `prisma db push` is idempotent: on an already-migrated database it prints
# "already in sync" and exits 0, and on a brand-new one it creates every table —
# so a fresh host converges by itself. It is *not* given --accept-data-loss on
# purpose: a change that would drop a column must be reviewed from the laptop,
# never applied silently to real student data. A failure here is logged and the
# server starts anyway, so /api/health stays up and the host does not crash-loop.
CMD ["sh", "-c", "prisma db push --skip-generate || echo '  ⚠️  تعذّرت مزامنة جداول قاعدة البيانات — سيبدأ الخادم على أي حال'; exec node dist/index.js"]
