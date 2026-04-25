#!/usr/bin/env bash
# Bring up the local dev stack for Service.AI: docker services + schema + seed.
# Idempotent — safe to re-run. Prints the seeded login credentials on success.
#
# After this script exits 0, run these two commands in separate terminals:
#   pnpm --filter @service-ai/api dev     # API on http://localhost:3001
#   pnpm --filter @service-ai/web dev     # Web on http://localhost:3000

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Ensuring docker services (postgres, redis) are up"
if ! docker ps --format '{{.Names}}' | grep -q '^servicetitan-postgres$'; then
  docker compose up -d postgres redis
else
  echo "    servicetitan-postgres already running"
fi

echo "==> Waiting for postgres to be healthy"
for i in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' servicetitan-postgres 2>/dev/null || echo "starting")
  if [ "$status" = "healthy" ]; then break; fi
  sleep 1
done
if [ "$status" != "healthy" ]; then
  echo "    postgres did not become healthy within 30s" >&2
  exit 1
fi
echo "    postgres healthy"

export DATABASE_URL="${DATABASE_URL:-postgresql://builder:builder@localhost:5434/servicetitan}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6381}"

echo "==> Applying migrations (0001 → 0013)"
# Windows hosts don't have psql on PATH, so run migrations inside the
# postgres container. Detect whether the schema is already present by
# looking for the phase-13 `payment_retries` table; skip migrations when
# it exists (CREATE POLICY is not IF NOT EXISTS-safe on PG < 17, so we
# can't blindly re-run migrations against an already-migrated DB).
already_migrated=$(
  docker exec -i servicetitan-postgres psql -U builder -d servicetitan -tAc \
    "SELECT to_regclass('public.notifications_log') IS NOT NULL"
)
if [ "$already_migrated" = "t" ]; then
  echo "    schema already up-to-date (payment_retries present) — skipping"
else
  for f in packages/db/migrations/*.sql; do
    case "$f" in
      *.down.sql) continue ;;
    esac
    name=$(basename "$f")
    printf '    %s ... ' "$name"
    docker exec -i servicetitan-postgres psql -U builder -d servicetitan -v ON_ERROR_STOP=1 -q < "$f" > /dev/null
    echo "ok"
  done
fi

echo "==> Seeding demo tenant tree (idempotent)"
pnpm --filter @service-ai/api run seed

cat <<'EOF'

==================================================================
  Service.AI local dev stack is ready.
==================================================================

  Start the servers (separate terminals):
    pnpm --filter @service-ai/api dev      # http://localhost:3001
    pnpm --filter @service-ai/web dev      # http://localhost:3000

  Sign in at http://localhost:3000/signin with one of:

  Platform admin:
    joey@opendc.ca

  Franchisee users (Denver + Austin each have six roles):
    denver.owner@elevateddoors.test        franchisee_owner
    denver.manager@elevateddoors.test      location_manager
    denver.dispatcher@elevateddoors.test   dispatcher
    denver.tech1@elevateddoors.test        tech
    denver.tech2@elevateddoors.test        tech
    denver.csr@elevateddoors.test          csr
    austin.* (same shape)

  Password for every seeded user:
    changeme123!A

  Reset everything:
    pnpm seed:reset

==================================================================
EOF
