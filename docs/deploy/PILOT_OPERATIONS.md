# Service.AI — Pilot Operations (W5.4)

How we run and judge the **30-day single-branch pilot** for Elevated Doors,
and how we back any one integration out fast if it misbehaves.

- Strategy / sequencing / acceptance per workstream → `docs/PILOT_GO_LIVE_PLAN.md`.
- Deploy mechanics (env values, push, migrate, GL smoke) → `docs/deploy/GO_LIVE_RUNBOOK.md`.
- This doc owns: **success metrics**, **daily check-in cadence**, and the
  **per-integration rollback one-pager**.

The pilot is **phased** (Wave 1 = money + ops live, calls human-answered;
Wave 2 = AI voice + auto-comms switched on per-capability). Metrics are tagged
`[W1]` / `[W2]` so we judge each wave against what's actually live.

---

## 1. 30-day success metrics

The pilot **passes** if, over 30 continuous days on one branch, the money +
ops path runs without manual DB surgery and the integrations stay healthy.
Targets are deliberately conservative for a first real run — the bar is
"trustworthy," not "optimized."

### Must-hit (a miss = pilot is not passing)

| # | Metric | Target | Source of truth |
|---|---|---|---|
| M1 | Quote→accept→deposit→complete→balance-invoice→paid cycles completed **without manual DB edits** | ≥ 1 fully clean cycle in week 1; **every** cycle clean by week 2 | `quotes`/`jobs`/`invoices` status logs; golden-path invariants |
| M2 | Double-charges / wrong-amount charges | **0** | Stripe dashboard vs. `payments` rows |
| M3 | Commission credited-once violations (commit credits; balance-invoice webhook must NOT re-credit) | **0** | `commission_ledger` (one row per committed quote) |
| M4 | Cross-tenant / unauthorized data exposure incidents | **0** | Sentry + audit_log review |
| M5 | Unplanned downtime of the money path (quote/accept/pay) | ≤ 1 incident, < 30 min, with a working rollback | Axiom uptime + incident notes |

### Health & quality (track daily; trend matters more than any single day)

| # | Metric | Target | Wave | Source |
|---|---|---|---|---|
| H1 | Stripe webhook processing success rate | ≥ 99% (retries resolve the rest) | W1 | `stripe_events` vs. Stripe deliveries |
| H2 | BC AI Agent `priceItems` p95 latency | within the SQB budget (sub-second p95) | W1 | Axiom traces (`X-Request-ID` threaded) |
| H3 | BC `commitQuote` / `convertQuoteToOrder` success rate | ≥ 99%; idempotent (concurrent commits → one BC doc) | W1 | provider logs + BC docs |
| H4 | API error rate (5xx) | < 0.5% of requests | W1 | Sentry + Axiom |
| H5 | API p95 latency (read endpoints) | < 400 ms | W1 | Axiom |
| H6 | **Stub-fallback warnings in prod logs** (a real key silently dropped → we're running on a stub) | **0** | Axiom: grep `falling back to stub` / `(stub) send` |
| H7 | Email / SMS delivery rate (once W3 keys live) | ≥ 98% delivered | W2 | Resend + Twilio dashboards |
| H8 | AI-answered calls that book correctly | ≥ 90% on answered calls | W2 | `ai_actions` + call review |
| H9 | AI guardrail violations (action above its confidence/$ cap without human approval) | **0** | `ai_actions` confidence vs. guardrail table |
| H10 | Low-confidence calls that escalate cleanly (no dropped customer) | 100% of escalations | W2 | call session review |

### Business signal (informational — not pass/fail for the pilot)

- Quotes created; close rate (accepted / sent); revenue processed; deposit
  collection rate; avg quote→accept time; jobs completed.
- These calibrate expectations for scale-out; the pilot is judged on M*/H*.

---

## 2. Daily check-in cadence

A ~10-minute standup, every pilot day, same checklist. Owner: Claude drafts the
day's summary from logs + DB; Joey reviews and flags anything off. The point is
to catch a silent regression (H6 especially) before it touches a customer.

**Each morning, review:**

1. **Money path** — any quote/invoice stuck mid-lifecycle overnight?
   Any Stripe webhook in `stripe_events` that errored (H1)? Any `payments`
   row whose amount disagrees with the invoice (M2)?
2. **Integration health** — scan Axiom for **H6 stub-fallback warnings**
   (`falling back to stub`, `(stub) send`, `using stubPlacesClient`,
   `stubObjectStore`). Any hit means a production key dropped and we're
   silently degraded — treat as a same-day fix.
3. **Errors** — new Sentry issues since yesterday; triage sev.
4. **BC bridge** — `commitQuote`/`convert` failures or latency regressions
   (H2/H3); confirm idempotency held on any retried commit.
5. **AI (Wave 2 only)** — yesterday's `ai_actions`: confidence distribution,
   any near-cap actions, every escalation resolved without a dropped customer.
6. **Punch-list** — anything from the W0 workflow-fit triage marked
   *fix-during* that surfaced in real use → schedule it.

**Weekly (Mondays):** roll the daily numbers into a one-screen trend
(M1–M5 + H1–H10) and decide which Wave-2 capability, if any, is ready to turn
on for the coming week.

---

## 3. Per-integration rollback one-pager

**Golden rule:** every external integration except Better Auth degrades to a
deterministic in-process **stub** when its keys are removed. So the fastest
rollback for most things is *unset the env var(s) in the DO dashboard and
redeploy* — the code already falls back, dev/CI behaviour is the proven-good
path, and no customer-visible crash occurs (the action just stops having a
real-world effect). **Exception: the BC AI Agent bridge has no in-prod stub —
see below.**

| Integration | Live when these are set | Rollback to stub | Stub behaviour (what "off" looks like) |
|---|---|---|---|
| **Stripe** | `STRIPE_SECRET_KEY` **and** `STRIPE_WEBHOOK_SECRET` | Unset **either** → `stubStripeClient` | Deterministic `pi_*` PaymentIntents, no real charge; webhooks still flip invoices `paid` from a posted stub event. **No money moves.** |
| **Email (Resend)** | `RESEND_API_KEY` **and** `EMAIL_FROM` | Unset `RESEND_API_KEY` → `loggingEmailSender` | Send is logged (`email (stub) send`), not delivered. Fall back to manual copy-paste link delivery (Wave-1 allows this). |
| **SMS (Twilio)** | `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + (`TWILIO_MESSAGING_SERVICE_SID` **or** `TWILIO_FROM_NUMBER`) | Unset `TWILIO_ACCOUNT_SID` → `loggingSmsSender` | Send logged (`sms (stub) send`), not delivered. |
| **Google Maps** | `GOOGLE_MAPS_API_KEY` (API) + `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (web) | Unset → `stubPlacesClient` + stub distance matrix | No autocomplete/geocode/distance; addresses entered free-text. Non-blocking for the money path. |
| **DO Spaces (photos)** | all five `DO_SPACES_ENDPOINT` / `REGION` / `BUCKET` / `KEY` / `SECRET` | Unset **any** → `stubObjectStore` | Uploads accepted in-memory, **not persisted** — photos lost on restart. Tolerable short-term; don't rely on photo evidence while stubbed. |
| **Voice AI (Wave 2)** | Twilio voice number + `DEEPGRAM_API_KEY` + `ELEVENLABS_API_KEY` | Detach Media Streams / unset keys → calls human-answered (Wave-1 mode) | CSR answers and types into Service.AI; every call still lands in CRM. This *is* the Wave-1 baseline. |
| **Better Auth** | `BETTER_AUTH_SECRET` (≥32 chars) | **No rollback — required.** Unsetting it is fatal in prod (dev-only placeholder otherwise). | Rotating the secret invalidates live sessions (everyone re-logs-in); never unset in prod. |
| **BC AI Agent bridge** | `suppliers` row: `provider_kind='bc_ai_agent'`, real `endpoint_url`, `X-Service-AI-Key` | **No in-prod stub fallback (see note).** Operational rollback: repoint `suppliers.endpoint_url` at a sandbox BC AI Agent, or remove/disable the supplier row to halt new quote commits (existing quotes/orders unaffected), forcing manual quoting. | With BC unreachable, `priceItems`/`commit` fail with provider errors (loud, not silent). There is no automatic mock. |

> **BC rollback note (correction to PILOT_GO_LIVE_PLAN.md W2).** The plan says
> the BC rollback is "point supplier row at MockProvider." That is **not
> currently possible in production**: the `supplier_provider_kind` DB enum
> contains only `'bc_ai_agent'` (no `'mock'`), and `defaultProviderRegistry()`
> registers only the `bc_ai_agent` factory — so `provider_kind` cannot be set
> to `mock` and no mock factory would resolve. Until that changes, the real BC
> rollback is the operational one in the table above. **Follow-up if we want a
> symmetric stub fallback:** add `'mock'` to the enum (new migration) and
> `registerFactory('mock', …)` in `defaultProviderRegistry()`, then rollback
> becomes a one-row `provider_kind` flip like everything else.

**After any rollback:** redeploy (env changes take effect on deploy), then
re-run the relevant `GO_LIVE_RUNBOOK.md` smoke check to confirm the stub path
is serving, and note the incident + trigger in the daily check-in.

---

_Status log_
- 2026-05-27 — W5.4 authored (metrics + cadence + rollback one-pager).
  Surfaced and documented the BC "MockProvider" rollback gap (enum + registry
  don't support it today); logged the follow-up to make BC rollback symmetric.
