# Service.AI — Go-Live Runbook (phase_go_live)

First real deploy of phases 14–19 to DO App Platform + production BC + real
Stripe. Produced by the GL validation pass (2026-05-20). **The push triggers
auto-deploy (`deploy_on_push: true`), so it is the LAST step.**

## Status of validation (GL-01..03, done locally)

- **GL-01 ✅ Migrations apply cleanly 0001→0020 on a fresh DB** (44 tables; all
  CHR/SQB/QOC/CQA/QF columns present). Two fixes/notes:
  - FIXED: `packages/db` `db:migrate` was stale (stopped at 0017) — now runs
    through 0020. `db:migrate:down` updated to match.
  - REQUIREMENT: migration `0016` uses a psql `\copy` (pricebook snapshot to a
    host CSV). Migrations **must** run via `psql` / `pnpm --filter @service-ai/db db:migrate`
    from the `packages/db` dir (NOT a node runner — `\copy` is psql-only).
    The deploy environment that runs migrations needs `psql` on PATH. On a
    fresh prod DB `pricebook_overrides` is empty, so the snapshot is trivial.
- **GL-02 ✅ Production builds pass** — `pnpm --filter @service-ai/api build`
  (tsc) and `pnpm --filter @service-ai/web build` (next build, all routes incl.
  `/invoices`, `/invoices/[id]`, `/quotes/[token]/accept`, `/invoices/[token]/pay`).
  Suites green: api 747, web 196, suppliers 45, db 83.
- **GL-03 ✅ `.do/app.yaml` env wiring completed.** The spec now references all
  required vars per service (payments, auth, WEB_ORIGIN, integrations) via
  `${VAR}` bindings + correct scopes (NEXT_PUBLIC_* are RUN_AND_BUILD_TIME);
  Redis resource confirmed present. **What remains is setting the secret
  VALUES in the DO dashboard** — the spec declares the keys, DO holds the
  secrets. The reference below lists every value to set.

## Required environment (the GL-03 gap)

`.do/app.yaml` currently declares only: web(`NEXT_PUBLIC_API_URL`,`SENTRY_DSN`,
`NODE_ENV`), api(`DATABASE_URL`,`REDIS_URL`,`AXIOM_TOKEN`,`AXIOM_DATASET`,
`SENTRY_DSN`,`NODE_ENV`), voice(`SENTRY_DSN`,`NODE_ENV`). Everything below is
**referenced by the code but NOT wired in the spec** — set these (as DO
app-level secrets, then reference per service) before the first real deploy.

### api — CRITICAL (money loop dies without these)
| Var | Why | Source |
|---|---|---|
| `BETTER_AUTH_SECRET` | session signing — auth dead without it | generate (high-entropy) |
| `BETTER_AUTH_URL` | auth base URL | the api public URL |
| `WEB_ORIGIN` | share links, accept-page CSRF allowlist, invoice pay links | the web public URL |
| `STRIPE_SECRET_KEY` | deposits + balance charges (else stub — no real money) | Stripe dashboard |
| `STRIPE_WEBHOOK_SECRET` | verifies `payment_intent.succeeded` (marks paid / stamps deposit) | Stripe webhook endpoint |
| `ANTHROPIC_API_KEY` | AI CSR/dispatcher/tech/collections | Anthropic |

### api — integrations (degrade to stub if absent)
`GOOGLE_MAPS_API_KEY` (places/geocode), `DO_SPACES_*` (KEY/SECRET/BUCKET/REGION/ENDPOINT — photo uploads), `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_MESSAGING_SERVICE_SID` (SMS), `RESEND_API_KEY` (email), `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_CONTACT` (push), `PLACES_COUNTRIES`, `LOG_LEVEL`.

### web — CRITICAL
| Var | Why |
|---|---|
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | the deposit + balance **card forms are dead without it** (the page shows "online payment not configured") |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | static maps on job/customer views |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | push subscription |

`NEXT_PUBLIC_*` are build-time inlined → must be set with `scope: RUN_AND_BUILD_TIME`.

### voice
`DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `TWILIO_*`, `ANTHROPIC_API_KEY`, `DATABASE_URL`.

### app.yaml status
- All vars above are now wired in `.do/app.yaml` (per-service `${VAR}`
  references + scopes). Set the secret VALUES in the DO dashboard.
- Redis resource is declared. PG is `production: false` (dev tier) — fine for
  the pilot; size up later.
- `BETTER_AUTH_URL` binds to `${api.PUBLIC_URL}` and `WEB_ORIGIN` to
  `${web.PUBLIC_URL}` — confirm these resolve to the intended hostnames after
  the first deploy (DO assigns them).

### BC AI Agent connection (not env — seeded data)
Service.AI reaches BC AI Agent per-supplier: the `suppliers` row holds
`endpointUrl` + an `apiKeySecretRef` whose value is read from `process.env`.
So go-live needs: (1) a real `X-Service-AI-Key` minted on the BC AI Agent side
(`POST /api/external-keys`, plaintext shown once), (2) that plaintext set as
the env var named by the supplier row's `apiKeySecretRef`, (3) the supplier row
seeded with the prod BC AI Agent URL + the Elevated Doors account code.

## Deploy steps (GL-04 — Joey)

1. Set all required env above as DO app-level secrets (the spec already
   references them via `${VAR}` — you only set the values in the dashboard).
2. Redis resource is already in the spec.
3. **Push `main`** → DO auto-deploys web/api/voice.
4. Run migrations against DO Managed Postgres:
   `DATABASE_URL=<do-pg-url> pnpm --filter @service-ai/db db:migrate`
   (from a host/CI with `psql` — NOT inside a node-only container).
5. Seed the Elevated Doors corporate + first branch + manager/CSR/tech +
   the supplier row (BC URL + account code + key ref). Provision the branch
   Twilio number via `/corporate/branches/new`.
6. Configure the Stripe webhook endpoint → `https://<api>/api/v1/webhooks/stripe`,
   copy its signing secret into `STRIPE_WEBHOOK_SECRET`.

## Post-deploy smoke + one real transaction (GL-05 — go/no-go)

1. Health: `GET /healthz` (api), web loads, sign in as the seeded manager.
2. Create customer + job; build a quote → it prices via **real BC**.
3. Commit → real `SQ-XXXXXX` appears in BC under Elevated Doors.
4. Share → open the accept link → **pay the deposit with a real card** →
   confirm `payment_intent.succeeded` fires and `deposit_paid_at` stamps.
5. Accept → real `SO-XXXXXX` order created in BC.
6. Schedule + complete the job → balance invoice auto-drafts (deposit credited).
7. Finalize + send from the office invoice console → **pay the balance with a
   real card** → invoice flips to paid; confirm commission credited **once**
   (at commit, not again at balance payment).

Passing #1–7 with real money + real BC = go for the 30-day pilot.

## Known gaps to watch during the pilot (not go-live blockers)
- TD-QF-01: cancelling an accepted/paid quote doesn't unwind the BC order /
  deposit / balance invoice.
- BC → Service.AI is one-way (no fulfillment status sync).
- Manual link delivery (copy-paste; no auto email/SMS yet).
