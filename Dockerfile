# BE-POS-App — demo container runtime (Render Free + Neon Postgres)
#
# This Dockerfile targets a traditional always-on Node process, NOT Vercel's
# serverless model. api/index.js already branches its own bootstrap on
# `process.env.VERCEL` — Render never sets that variable, so running this
# image on Render activates Socket.IO, the four in-process schedulers, and
# graceful shutdown automatically, with ZERO code changes required. See
# PHASE 6D-0 report for the evidence trail; do not "helpfully" remove that
# guard here — it already does the right thing for this runtime.
#
# Deliberately excluded from this image: no `sequelize-cli db:migrate` step
# (see P6-06 — the historical migration chain is not bootstrap-safe against a
# fresh database) and no reliance on a durable local filesystem (Render Free's
# container disk is ephemeral across deploys/restarts — fine for transient
# work like generated invoice PDFs, NOT a backup destination).

# ---- deps: install with native build tools available, prod deps only ----
FROM node:20-slim AS deps
WORKDIR /app

# python3/make/g++ back a source-compile fallback for native addons (bcrypt)
# if a prebuilt binary isn't available for this image's exact platform. Not
# kept in the final runtime stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: slim final image, no build tools, non-root ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system app && useradd --system --gid app --home /app app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# public/invoices is written to at runtime by utils/generateInvoicePdf.js
# (non-Vercel branch) — pre-create it so the non-root user doesn't need to
# create a directory under a path it may not own.
RUN mkdir -p public/invoices && chown -R app:app /app

USER app

# Informational default; Render injects its own PORT and the app already
# honors it (`api/index.js`: `const port = process.env.PORT || 5001`).
EXPOSE 5001

# Reuses the existing /health endpoint (SELECT 1 against the DB, 200/503) —
# see api/index.js. No new health-check logic introduced.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5001)+'/health',res=>process.exit(res.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Not `npm start` (that's `nodemon`, a dev-only file watcher/restarter with
# no place in an immutable container) — runs the same entrypoint Vercel uses
# (`main: api/index.js`) directly under plain node.
CMD ["node", "api/index.js"]
