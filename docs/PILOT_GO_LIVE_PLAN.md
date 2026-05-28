# Service.AI — Pilot Go-Live Plan (living doc)

**Goal (locked 2026-05-26):** Elevated Doors runs **one branch end-to-end on
Service.AI for 30 continuous days**. Timeline: **ASAP — within a few weeks**.
Planning depth concentrated on **live-integration validation, AI quality &
automation, and real-world workflow fit**.

This is the living plan. Deploy *mechanics* (env vars, push, migrate, GL-04/05
smoke) are not duplicated here — see `docs/deploy/GO_LIVE_RUNBOOK.md`. This doc
owns the *strategy, sequencing, acceptance, and rollback* for each workstream.

---

## Strategic shape: two waves

"ASAP" and "high-quality AI phone answering" are in tension — real AI voice is
the hardest, highest-risk integration and needs iteration against real calls.
So the pilot is **phased** (decided 2026-05-26):

- **Wave 1 — go-live (the few-weeks target).** The money + ops path runs live:
  quoting against real BC, customer accept + deposit, dispatch, tech app,
  completion, balance invoice, real Stripe. **Calls are human-answered**, but
  the CSR types into Service.AI so every call still lands in CRM.
- **Wave 2 — during the 30-day pilot.** AI voice answering and auto email/SMS
  send switch on per-capability, behind the confidence gates, human-approved
  until each earns autonomy.

This protects the timeline *and* AI quality: the AI goes live when it's good,
not on a deadline.

---

## Current reality (baseline)

- Code is ~95% complete; **validated only against an in-memory stub layer.**
  No real Stripe charge, BC price, phone call, email, or photo upload has ever
  run. The stubs are deterministic (great for dev/CI); reality check = zero.
- `GO_LIVE_RUNBOOK.md` GL-01..03 are ✅ locally: migrations apply 0001→0020 on
  a fresh DB; prod builds pass; `.do/app.yaml` references every required var.
- **Genuine code gap:** email/SMS senders return logging stubs even when keys
  are set ("lands with the first real send path") — see W3.
- ~~**No E2E specs run in CI** (Playwright/k6 scaffolded only)~~ — golden-path
  E2E now runs in CI as a live integration test (W5.1 done); browser/k6 still
  scaffolded only.

---

## Workstreams

Legend — owner: **C** = Claude (autonomous), **J** = Joey (needs you),
**C+J** = collaborative.

### W0 — Workflow-fit walkthrough  · owner C+J · **do first**
Catch "software does X, we actually do Y" mismatches *before* go-live, while
they're cheap to fix. Checklist: `docs/PILOT_WORKFLOW_FIT.md`.
- Joey walks each real Elevated Doors flow against the software; logs
  divergences. Claude pre-fills what the software does today.
- Each divergence triaged: **fix-before-pilot / fix-during / WONTFIX-v1**.
- **Acceptance:** every lifecycle stage reviewed; punch-list triaged; the
  fix-before-pilot items become tracked tasks.
- **Why first:** this is the single biggest source of post-build rework — the
  thing the user explicitly wants to avoid.

### W1 — Infrastructure & low-risk integrations live  · owner J (Claude preps)
Dependency-ordered, lowest blast-radius first. Env keys already wired in
`.do/app.yaml`; what remains is setting secret *values* in DO + validating.
1. **Prod DB migrations** — run 0001→0020 on DO Postgres (GL-01 validated the
   set). NOTE: migration 0016 uses a psql `\copy`, so migrations must run via
   `psql`/`pnpm --filter @service-ai/db db:migrate` from a host with `psql` on
   PATH, **not** a node-only container. Decision pending: keep as the runbook's
   manual step (recommended, given `\copy`) vs. a DO PRE_DEPLOY job.
2. **Better Auth** — real `BETTER_AUTH_SECRET`; verify session lifetime/refresh
   in the DO environment (never tested there).
3. **Google Maps** — real key; verify autocomplete + geocode + distance matrix.
4. **DO Spaces** — real creds; verify a real photo upload + signed-URL round trip.
- **Acceptance per item:** real test request succeeds; documented rollback
  (flip the env var back → code falls back to stub).

### W2 — The money path live (Wave 1 core)  · owner C+J · **critical path**
Order matters; this is the gating risk for go-live.
1. **Stripe — test mode.** Full deposit + balance charge against Stripe test
   cards; real webhook → `paid_at` → commission credit. Confirm the
   credited-once rule (credit at commit; balance-invoice webhook skips it)
   holds with a *real* webhook, not the stub. (Claude can drive most of this
   with test keys.)
2. **Stripe — live mode (GL-05).** Real card, small real amount, real refund.
   The true go-live gate. (Joey: real Stripe account + card.)
3. **BC AI Agent bridge — live.** Seed the real `suppliers` row + mint
   `X-Service-AI-Key`; point at prod BC AI Agent. Validate: real `priceItems`
   (p95 under budget), `commitQuote` → real `SQ-XXXXXX`, `convertQuoteToOrder`
   → real `SO-XXXXXX`, idempotency (concurrent commits collapse to one BC doc).
   Lower risk than usual because Joey owns both sides (OPENDC's BC AI Agent).
- **Acceptance:** GL-05 smoke #1–7 pass with real money + real BC.
- **Rollback:** unset Stripe keys → stub; flip `suppliers.provider_kind` to
  `'mock'` → BC degrades to MockSupplierProvider (migration 0026, takes effect
  on redeploy). Full per-integration table: `docs/deploy/PILOT_OPERATIONS.md` §3.

### W3 — Communications (real send path — code work, not just config)  · owner C
Email/SMS auto-send is **not wired** — senders return stubs even with keys.
1. Implement real `resolveEmailSender` (Resend) + `resolveSmsSender` (Twilio)
   behind the existing interfaces.
2. Validate real delivery: accept-link email, invoice send, collections
   follow-up.
- **Wave decision:** Wave 1 can ship with manual copy-paste link delivery (the
  runbook allows it). This workstream may land early in Wave 2 if it threatens
  the few-weeks target.
- **Acceptance:** a real email + real SMS delivered end-to-end; collections
  draft can be sent (still human-approved per the 0.90 guardrail).

### W4 — AI voice + automation quality (Wave 2)  · owner C+J
The "AI quality" focus area.
1. **Twilio voice** — provision the branch number; connect Media Streams to the
   voice WS server. (Joey: Twilio account / number.)
2. **Deepgram + ElevenLabs + Claude** — real keys; make test calls; tune until
   the AI sounds right and books correctly.
3. **Confidence gates & escalation** — validate the guardrail table
   (csr.bookJob 0.80, csr.commitQuote 0.90/$5k, dispatcher.autoAssign 0.80,
   tech.photoQuote 0.75/$500, collections.sendDraft 0.90) against real calls;
   confirm low-confidence escalates to a human cleanly.
4. **Turn on per-capability**, human-approving each AI action until it earns
   autonomy.
- **Acceptance:** an AI-answered call books a real job correctly; a botched/
  low-confidence call escalates to a human without dropping the customer.

### W5 — Dress rehearsal & 30-day pilot operations  · owner C+J
1. **E2E specs (C): ✅ done.** The golden path (book → quote → accept →
   complete → invoice → pay) is machine-verified by
   `apps/api/src/__tests__/live-golden-path.test.ts`. It drives the real
   Fastify routes + Postgres with only the external adapters stubbed
   (supplier = `MockSupplierProvider`; Stripe/email/SMS = the env-gated
   stubs), so it runs green in the existing `pnpm -r test` CI job with no
   browser infra or third-party keys. Chosen over a browser-driven
   Playwright spec (the scaffolded `tests/e2e/` files) for CI stability;
   a UI E2E remains a deferred follow-up if we want click-through coverage.
2. **Dress rehearsal (C+J):** one full real job lifecycle, internal, on live
   services with a small real transaction — before any customer.
3. **Monitoring (C):** confirm Axiom + Sentry actually receive prod logs/errors.
4. **Pilot run (C+J):** ✅ **ops plan drafted** — 30-day success metrics, daily
   check-in cadence, and the per-integration rollback one-pager live in
   `docs/deploy/PILOT_OPERATIONS.md`. Running the 30 days is C+J once live.
- **Acceptance:** golden-path E2E green in CI; dress rehearsal completes with a
  real transaction; monitoring confirmed live.

---

## Critical path & sequencing

```
W0 (workflow fit) ─┐
                   ├─→ W2 (money path) ─→ W5 dress rehearsal ─→ WAVE 1 GO-LIVE
W1 (infra) ────────┘
                              W3 (comms) ─┐
                              W4 (voice) ─┴─→ WAVE 2 (during the live pilot)
```

W0 and W1 run in parallel (no conflict). Gating risk = **W2 Stripe-live +
BC-live**. W3/W4 are deferrable to Wave 2.

## Open decisions
- **D1 — migrations on prod:** runbook manual `psql` step (recommended) vs. DO
  PRE_DEPLOY job. Blocked by the `\copy` in migration 0016.
- **D2 — W0 format:** structured checklist (chosen) — `PILOT_WORKFLOW_FIT.md`.
- **D3 — first branch identity / Twilio area code** (Elevated Doors pilot branch).

## Joey-only checklist (the things Claude cannot do)
- Set production secret *values* in the DO dashboard (keys already in app.yaml).
- Real Stripe account + a real card for GL-05.
- Mint the BC `X-Service-AI-Key` on the BC AI Agent side; seed the supplier row.
- Provision the branch Twilio number.
- Answer the W0 workflow questions (`PILOT_WORKFLOW_FIT.md`).

---

_Status log_
- 2026-05-26 — Plan created. Scope locked to single-branch 30-day pilot, phased
  Wave 1/Wave 2, ASAP. W0 + W1 starting in parallel.
- 2026-05-28 — BC rollback symmetry **done**: migration `0026_supplier_mock_kind`
  adds `'mock'` to the `supplier_provider_kind` enum + `defaultProviderRegistry()`
  registers `mockFactory`, so a BC outage rollback is a one-row `provider_kind`
  flip (validated up/down on a live DB; down fails safely while a `mock` row
  exists). Closes the gap found during W5.4.
- 2026-05-27 — W5.1 **done**: golden-path E2E (`live-golden-path.test.ts`) green
  in CI (commit `4d1c05a`). W5.4 **ops plan drafted**: metrics + daily cadence +
  rollback one-pager (`docs/deploy/PILOT_OPERATIONS.md`); surfaced the BC
  "MockProvider" rollback gap (enum + registry don't support it — follow-up
  logged to add `'mock'` to the enum + register the factory for symmetric rollback).
- 2026-05-26 — W3 **code complete** (pulled forward while W0/W1 await Joey):
  real Resend email + Twilio SMS senders in `apps/api/src/notify.ts` (native
  fetch, env-gated, stub fallback unchanged), 11 unit tests, `EMAIL_FROM` +
  `TWILIO_FROM_NUMBER` added to `app.yaml`. Remaining for W3: live delivery
  validation (needs `RESEND_API_KEY`/`EMAIL_FROM` + Twilio creds — Joey).
  Note: the invoice-console "Send" action is still a state-flip + copy-link
  (no email dispatch yet) — minor follow-up if auto invoice email is wanted.
