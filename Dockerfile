# syntax=docker/dockerfile:1.7

# ------------------------------------------------------------------------------
# base: node 22 + pnpm (via corepack) + claude-code CLI + git/bash for the runner
# ------------------------------------------------------------------------------
FROM node:22-alpine AS base
RUN apk add --no-cache bash git tini docker-cli
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app

# ------------------------------------------------------------------------------
# deps: install node_modules once; cached between dev and builder stages
# ------------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
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
# Mountpoints für Bind-Volumes vorab als node anlegen, falls der Host-Pfad noch leer ist.
RUN mkdir -p /app/projects /app/.specifyr && chown -R node:node /app/projects /app/.specifyr
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production
EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", ".output/server/index.mjs"]
