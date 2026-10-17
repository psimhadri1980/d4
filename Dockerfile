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
