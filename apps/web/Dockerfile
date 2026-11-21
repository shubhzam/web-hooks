FROM node:24-slim AS base
RUN corepack enable pnpm
WORKDIR /app

# stage 1: cut the monorepo down to the web app and what it depends on
FROM base AS prune
RUN npm install -g turbo@2.11.13
COPY . .
RUN turbo prune web --docker

# stage 2: install everything and build
FROM base AS build
COPY --from=prune /app/out/json/ .
COPY --from=prune /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=prune /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm install --frozen-lockfile
COPY --from=prune /app/out/full/ .
RUN pnpm turbo run build --filter=web

# stage 3: standalone server only, no pnpm and no node_modules install
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]