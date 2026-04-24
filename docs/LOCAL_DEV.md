# Local dev — running Service.AI on your machine

Everything you need to open http://localhost:3000 and click
through the app as a platform admin, franchisor admin, franchisee
owner, dispatcher, tech, or CSR.

---

## First-run bootstrap (one command)

```bash
bash scripts/dev-up.sh
```

The script ensures docker services are healthy, applies the 13
migrations (or skips if the schema is already present), seeds the
demo tenant tree, and prints login credentials.

Then in two separate terminals:

```bash
pnpm --filter @service-ai/api dev     # http://localhost:3001
pnpm --filter @service-ai/web dev     # http://localhost:3000
```

Sign in at http://localhost:3000/signin.

---

## Seeded logins

Every seeded user shares the password `changeme123!A`.

| Email | Role | Scope |
|---|---|---|
| `joey@opendc.ca` | platform_admin | platform |
| `denver.owner@elevateddoors.test` | franchisee_owner | Denver |
| `denver.manager@elevateddoors.test` | location_manager | Denver |
| `denver.dispatcher@elevateddoors.test` | dispatcher | Denver |
| `denver.tech1@elevateddoors.test` | tech | Denver |
| `denver.tech2@elevateddoors.test` | tech | Denver |
| `denver.csr@elevateddoors.test` | csr | Denver |
| `austin.owner@elevateddoors.test` | franchisee_owner | Austin |
| `austin.manager@elevateddoors.test` | location_manager | Austin |
| `austin.dispatcher@elevateddoors.test` | dispatcher | Austin |
| `austin.tech1@elevateddoors.test` | tech | Austin |
| `austin.tech2@elevateddoors.test` | tech | Austin |
| `austin.csr@elevateddoors.test` | csr | Austin |

There is no seeded franchisor admin. To get a franchisor scope,
sign in as `joey@opendc.ca` (platform), go to `/franchisor`, and
use "View as" to impersonate a franchisee — or use the onboarding
wizard at `/franchisor/onboard` to create a new franchisee and
invite a franchisor admin into it.

---

## What to try, by role

- **Platform admin** (`joey@opendc.ca`) — the full network view.
  - `/franchisor` — network dashboard (revenue / AR / AI spend
    / franchisee count tiles + per-franchisee table).
  - `/franchisor/onboard` — 4-step wizard to spin up a new
    franchisee end-to-end.
  - `/franchisor/audit` — audit log with text search + kind
    dropdown filters.
  - "View as" button on any row — impersonates a franchisee,
    banner appears, clicking Sign out drops back.
- **Franchisee owner** — the operator view.
  - `/dashboard` — landing.
  - `/customers`, `/jobs`, `/dispatch` — core operator flows.
  - `/pricebook` — editable per-franchisee catalog with
    publisher-template inheritance.
  - `/collections` — AR aging review queue with three-tone
    drafts (friendly / firm / final).
  - `/statements` — royalty statements owed to HQ.
- **Tech** (`*.tech1@…`) — the PWA surface.
  - `/tech` — today's jobs.
  - `/tech/jobs/:id` — job detail with status transitions,
    photo capture, AI photo quote, draft-from-notes.
- **Dispatcher / CSR** — booking + dispatch.
  - `/dispatch` — drag-and-drop board with AI auto-assign
    suggestions.
  - CSR can intake via the voice path too — see below.

---

## External integrations

Every third-party adapter has a stub fallback. Set the env var
(in `.env`, then restart `pnpm --filter @service-ai/api dev`) to
exercise the real path.

| Capability | Env vars | Stub behaviour when unset |
|---|---|---|
| AI reasoning | `ANTHROPIC_API_KEY` | Deterministic template replies |
| Payments | `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | Fake Stripe client; 409 `STRIPE_NOT_READY` on onboarding link |
| Voice telephony | `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` | Voice path is non-functional |
| Voice ASR | `DEEPGRAM_API_KEY` | Voice path is non-functional |
| Voice TTS | `ELEVENLABS_API_KEY` | Voice path is non-functional |
| Addresses | `GOOGLE_MAPS_API_KEY` | Deterministic stub places (Denver/Austin/Vancouver/Toronto) |
| Address country restriction | `PLACES_COUNTRIES` (e.g. `ca` or `ca,us`) | No restriction (global) |
| Photo storage | `DO_SPACES_*` (5 vars) | In-memory, photos lost on restart |
| SMS + email | `TWILIO_*` | Logs to stdout |

---

## Common operations

```bash
# Reset the demo data (keeps schema, clears tenants + Better Auth tables)
pnpm seed:reset

# Re-run seed (idempotent)
pnpm seed

# Connect to the dev DB from the host
docker exec -it servicetitan-postgres psql -U builder -d servicetitan

# Tail API logs with pretty formatting
pnpm --filter @service-ai/api dev | pnpm --filter @service-ai/api exec pino-pretty

# Run the full test suite
DATABASE_URL="postgresql://builder:builder@localhost:5434/servicetitan" pnpm turbo test --force

# Stop docker services
docker compose stop postgres redis

# Completely wipe the DB (drops the volume — you'll need to re-run dev-up.sh)
docker compose down -v
```

---

## Troubleshooting

**API exits with `FATAL: DATABASE_URL is not set`** — the api dev
script uses `tsx --env-file=../../.env`, so the root `.env` must
exist. If you just cloned, copy `.env.example` to `.env` (and
fill in `ANTHROPIC_API_KEY` if you want live AI).

**`'psql' is not recognized`** — the dev-up.sh script runs
migrations inside the postgres container via `docker exec`, so
you don't need psql on your Windows PATH. If you still see this,
you're running `pnpm db:migrate` directly — use `scripts/dev-up.sh`
instead.

**Sign-in returns 401 but the email is correct** — seed may not
have run. `pnpm seed` is idempotent; re-run it.

**Port conflict on 3000 / 3001 / 5434 / 6381** — another process
is using the port. On Windows: `netstat -ano | findstr :3001`
then `taskkill /PID <pid> /F`.

**Schema out of sync after pulling main** — if new migrations
landed, `docker compose down -v && bash scripts/dev-up.sh` blows
the volume and starts fresh.
