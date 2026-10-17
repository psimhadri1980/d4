# Builds the whole TypeScript monorepo in a container, so no local Node install is required.
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS build
COPY . .
# No lockfile exists yet on first run; once pnpm-lock.yaml is committed this installs from it.
RUN pnpm install && pnpm build

# `docker compose run --rm test` runs the full test suite.
FROM build AS test
CMD ["pnpm", "test"]

FROM base AS api
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
EXPOSE 3000
HEALTHCHECK --interval=10s --retries=6 CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "dist/main.js"]
