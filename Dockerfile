# syntax=docker/dockerfile:1.7

# ------------------------------------------------------------------------------
# base: node 22 + pnpm (via corepack) + hermes CLI + git/bash for the runner
# ------------------------------------------------------------------------------
FROM node:22-alpine AS base
# `curl` is needed by the Hermes installer below; it is NOT in node:22-alpine
# by default.
RUN apk add --no-cache bash git tini docker-cli curl
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable
# Install Hermes Agent CLI for multi-agent workflows.
# Run via bash (not sh): the upstream installer uses bash-only syntax
# (e.g. arithmetic `((…))`), which busybox `sh` on Alpine doesn't parse.
# Download-then-execute (not `curl … | bash`): a piped download swallows
# curl's exit code, so a partial/empty response lets bash exit 0 and the
# image looks healthy without Hermes actually installed.
ARG HERMES_INSTALL_URL=https://hermes-agent.nousresearch.com/install.sh
RUN curl -fsSL "${HERMES_INSTALL_URL}" -o /tmp/hermes-install.sh \
 && bash /tmp/hermes-install.sh \
 && rm -f /tmp/hermes-install.sh
WORKDIR /app

# ------------------------------------------------------------------------------
# deps: install node_modules once; cached between dev and builder stages
# ------------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ------------------------------------------------------------------------------
# dev: Nuxt dev server with HMR. Source is expected as a bind mount at /app.
# --chown sorgt dafür, dass anonyme Volumes (/app/node_modules, /app/.nuxt) dem
# node-User gehören — sonst scheitern Schreibzugriffe zur Laufzeit.
# ------------------------------------------------------------------------------
FROM base AS dev
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
RUN mkdir -p /app/.nuxt /app/.output && chown node:node /app/.nuxt /app/.output
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=development
EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "dev"]

# ------------------------------------------------------------------------------
# builder: produce .output/ via nuxt build
# ------------------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ------------------------------------------------------------------------------
# prod: minimal runtime. Ships .output/ AND src/ — the server dynamically imports
# src/core/*.js at runtime (see server/utils/specifyr-stores.ts loadModule()), so
# Nitro's bundle alone is not self-contained.
# ------------------------------------------------------------------------------
FROM base AS prod
COPY --chown=node:node --from=builder /app/.output ./.output
COPY --chown=node:node --from=builder /app/src ./src
COPY --chown=node:node --from=builder /app/package.json ./package.json
# Drizzle's runtime migrator (server/plugins/db.ts) reads SQL files from
# disk at boot. Nitro doesn't bundle them, so we copy them explicitly.
# The plugin resolves them relative to process.cwd() = /app.
COPY --chown=node:node --from=builder /app/server/db/migrations ./server/db/migrations
# Bundled local extensions: clone speckit-company so it appears in the workflow
# picker out-of-the-box. Not auto-installed into projects (kein Default-Workflow);
# the bundled-extensions injector in src/core/app-config.js merges it into
# localExtensions whenever the path exists. Override the ref via build-arg,
# e.g. `--build-arg SPECKIT_COMPANY_REF=v0.1.0` to pin a release tag.
ARG SPECKIT_COMPANY_REF=main
RUN git clone --depth 1 --branch ${SPECKIT_COMPANY_REF} \
        https://github.com/haexhub/speckit-company.git /app/extensions/speckit-company \
 && rm -rf /app/extensions/speckit-company/.git \
 && chown -R node:node /app/extensions
# Mountpoints für Bind-Volumes vorab als node anlegen, falls der Host-Pfad noch leer ist.
RUN mkdir -p /app/projects /app/.specifyr && chown -R node:node /app/projects /app/.specifyr
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production
EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", ".output/server/index.mjs"]
