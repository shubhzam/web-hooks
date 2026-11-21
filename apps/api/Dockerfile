FROM node:24-slim AS base
RUN corepack enable pnpm
WORKDIR /app

# stage 1: cut the monorepo down to the api and what it depends on
FROM base AS prune
RUN npm install -g turbo@2.11.13
COPY . .
RUN turbo prune api --docker

# stage 2: install everything and build, package.json files first so the install layer caches
FROM base AS build
COPY --from=prune /app/out/json/ .
COPY --from=prune /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=prune /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm install --frozen-lockfile
COPY --from=prune /app/out/full/ .
RUN pnpm turbo run build --filter=api

# stage 3: runtime with production dependencies and built output only
FROM base AS runner
ENV NODE_ENV=production
COPY --from=prune /app/out/json/ .
COPY --from=prune /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=prune /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
USER node
WORKDIR /app/apps/api
EXPOSE 3001
CMD ["node", "dist/index.js"]