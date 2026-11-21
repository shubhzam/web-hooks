# web-hooks

Reliable multi-tenant webhook delivery system, built feature by feature. This repo is the scaffold: a working local environment with no webhook logic yet.

## Stack

- Turborepo, pnpm workspaces, Node 24, TypeScript 7
- `apps/api`: Express 5, Prisma 7 (PostgreSQL), ioredis
- `apps/web`: Next.js 16
- `packages/shared`: zod schemas shared by api and web, compiled to `dist`
- PostgreSQL 18 and Redis 8 through Docker Compose

## Local development

```bash
cp .env.example .env
pnpm install
docker compose up -d postgres redis
pnpm dev
```

Web runs on port 3000 and api on port 3001.

## Full stack in containers

```bash
pnpm verify
```

Builds both images, starts all four services, waits for healthy, then checks the api and the web page. Stop with `docker compose down`.

## Health endpoints

- `GET /health/live`: liveness, no dependency checks
- `GET /health`: readiness, 200 when PostgreSQL is reachable and 503 otherwise, Redis is reported but not required

## Adding features

Kafka arrives with event ingestion. Prisma models, migrations and webhook logic arrive feature by feature.