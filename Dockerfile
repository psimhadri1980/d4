# Builds the whole TypeScript monorepo in a container, so no local Node install is required.
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
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

# Static web app (built above) served by nginx.
FROM nginx:1.27-alpine AS web
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

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
