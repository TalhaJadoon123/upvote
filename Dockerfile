# syntax=docker/dockerfile:1
# Build context is the repo root so the workspace packages resolve.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# ---- dependencies (cached independently of source) ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/voice/package.json packages/voice/
COPY packages/gh/package.json packages/gh/
COPY packages/reddit/package.json packages/reddit/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/analytics/package.json packages/analytics/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---- builder ----
FROM deps AS builder
COPY tsconfig.base.json tsconfig.package.json ./
COPY packages ./packages
RUN pnpm --filter @upvote/web build

# ---- runner ----
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/web/.next ./packages/web/.next
COPY --from=builder /app/packages/web/next.config.mjs ./packages/web/next.config.mjs
COPY --from=builder /app/packages/web/package.json ./packages/web/package.json

USER nextjs
EXPOSE 3000
ENV PORT=3000
# Liveness only. A readiness gate that depends on the database will pull every
# container out of rotation when Postgres has a bad minute, which is a worse
# outage than serving stale reads.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/packages/web
CMD ["pnpm", "start"]