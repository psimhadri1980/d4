# Builds the whole TypeScript monorepo in a container, so no local Node install is required.
FROM node:24-alpine AS base
# git: the Git model-as-code connector clones repositories (worker, and the test suite).
RUN apk add --no-cache git && corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS build
# Download packages from the lockfile alone, so this layer is cached until dependencies change.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm build

# `docker compose run --rm test` runs the full test suite.
FROM build AS test
CMD ["pnpm", "test"]

FROM base AS api
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
EXPOSE 3000
HEALTHCHECK --interval=10s --retries=6 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/main.js"]

# Background job worker (exports, spreadsheet imports) from the Redis queue.
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/worker
HEALTHCHECK --interval=10s --retries=6 CMD wget -qO- http://127.0.0.1:3002/healthz || exit 1
CMD ["node", "dist/main.js"]

# Renderer: PNG/PDF with headless Chromium. Playwright's image has the browser for
# playwright-core 1.47.2 but an older Node, so Node 24 is copied in (both are glibc); the app
# comes from the build stage (pure JS dependencies).
FROM mcr.microsoft.com/playwright:v1.47.2-jammy AS renderer
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/renderer
HEALTHCHECK --interval=10s --retries=6 CMD wget -qO- http://127.0.0.1:3003/healthz || exit 1
CMD ["node", "dist/main.js"]

# Static web app (built above) served by nginx; /config.json is written from the environment
# when the container starts, so one image serves any environment.
FROM nginx:1.27-alpine AS web
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 deploy/web/config.sh /docker-entrypoint.d/40-d4-config.sh
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

# Development-only mocks (mocks/*): no runtime dependencies, so only their compiled files.
FROM node:24-alpine AS mock-s3
RUN mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=build /repo/mocks/s3/dist ./dist
USER node
EXPOSE 8333
HEALTHCHECK --interval=5s --retries=20 CMD wget -qO- http://127.0.0.1:8333/_health >/dev/null || exit 1
CMD ["node", "dist/main.js"]

FROM node:24-alpine AS mock-smtp
WORKDIR /app
COPY --from=build /repo/mocks/smtp/dist ./dist
USER node
EXPOSE 1025 8025
HEALTHCHECK --interval=5s --retries=20 CMD wget -qO- http://127.0.0.1:8025/readyz >/dev/null || exit 1
CMD ["node", "dist/main.js"]

# Browser tests: Playwright's image (browsers included) plus socat for port forwarding.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy AS e2e
RUN apt-get update && apt-get install -y --no-install-recommends socat && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/e2e/package.json apps/e2e/
RUN pnpm install --frozen-lockfile --filter @d4/e2e
COPY apps/e2e apps/e2e
COPY samples samples
COPY deploy/e2e/run.sh /usr/local/bin/d4-e2e
ENTRYPOINT ["d4-e2e"]
