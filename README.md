# Service.AI — AI-Native Field Service Platform

An AI-native field service platform for trades, launched on garage doors, designed as a franchise platform from day one. First production customer: Elevated Doors (US).

## Prerequisites

- Node.js 20+
- pnpm 9+
- Docker + Docker Compose (for local dev)
- A Postgres 16 instance (provided via Docker Compose locally)
- A Redis 7 instance (provided via Docker Compose locally)

## Quick Start

```bash
# Install dependencies
pnpm install

# Start all services (web, api, voice, postgres, redis)
docker compose up
```

Services will be available at:
- Web: http://localhost:3000
- API: http://localhost:3001
- Voice: http://localhost:8080

## Per-Service Dev Commands

```bash
# Run each service in development mode
pnpm --filter @service-ai/web dev       # Next.js on port 3000
pnpm --filter @service-ai/api dev       # Fastify API on port 3001
pnpm --filter @service-ai/voice dev     # Fastify WS on port 8080

# Build all packages
pnpm build

# Run typechecks across the monorepo
pnpm -r typecheck

# Run linter across the monorepo
pnpm -r lint
```

## Database Migrations

```bash
# Apply migrations
pnpm db:migrate

# Revert last migration
pnpm db:migrate:down

# Seed development data
pnpm seed

# Reset seed data (preserves migrations)
pnpm seed:reset
```

## Environment Variable Reference

| Variable | Service | Description |
|---|---|---|
| `DATABASE_URL` | api | Postgres connection string |
| `REDIS_URL` | api | Redis connection string |
| `NEXT_PUBLIC_API_URL` | web | Public API base URL |
| `AXIOM_TOKEN` | api, voice | Axiom log ingestion token |
| `AXIOM_DATASET` | api, voice | Axiom dataset name (default: service-ai) |
| `SENTRY_DSN` | web, api, voice | Sentry error reporting DSN |
| `NODE_ENV` | all | `development` or `production` |

Copy `.env.example` to `.env` and fill in values for local development. Never commit `.env`.

## Rollback Procedure

To roll back a failed DigitalOcean App Platform deployment:

1. **Via DO Console**: Go to the App Platform console → Select your app → Deployments → Click the previous successful deployment → "Redeploy"
2. **Via doctl CLI**:
   ```bash
   # List recent deployments
   doctl apps list-deployments <app-id>
   # Revert to a previous deployment
   doctl apps create-deployment <app-id> --wait
   ```
3. **Via git revert**: Revert the offending commit and push to main — DO auto-deploys the revert.

For database migrations: always write reversible migrations with `up` and `down` SQL. Run `pnpm db:migrate:down` to revert.

## Running Tests

```bash
# Unit + integration tests (Vitest)
pnpm test

# Run a specific test file
npx vitest run tests/foundation/fnd-09-do-spec.test.ts

# End-to-end tests (Playwright)
pnpm test:e2e

# Performance tests (k6)
pnpm test:perf
```

## DigitalOcean App Platform

The `.do/app.yaml` spec describes all three services (web, api, voice), managed Postgres 16, and managed Redis 7. Push to `main` triggers automatic redeployment of all services.

To validate the spec locally:
```bash
doctl apps spec validate .do/app.yaml
```
