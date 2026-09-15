# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# A build-time DATABASE_URL keeps Next from failing while it collects page data;
# nothing connects until a request actually arrives.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
RUN groupadd --system --gid 1001 looks \
 && useradd --system --uid 1001 --gid looks --create-home looks

# Runtime deps only: next, react, pg, pg-boss, sharp, drizzle, zod, aws4fetch,
# plus tsx which runs the job worker straight from TypeScript.
RUN mkdir -p /app && chown -R looks:looks /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
# `next start` reads public/ from disk at runtime: the service worker and any
# static asset live here, so it has to be in the image.
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/drizzle ./drizzle

RUN mkdir -p /app/data/media && chown -R looks:looks /app/data
USER looks
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
