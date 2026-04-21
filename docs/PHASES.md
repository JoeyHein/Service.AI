# Service.AI — Phases

13 phases, each a shippable vertical slice. The run-build.sh parser locates phases by `## phase_<snake_case_name>` headings — do not rename without updating the regex.

Each phase must produce: **running code**, **passing tests**, **documentation**, and **updated gate**. Phase is not complete until its audit returns Verdict: PASS and its gate review is APPROVED.

---

## phase_foundation

**Goal**: Bare skeleton running on DO App Platform with CI. Everything that comes after assumes this works.

**Vertical slice**: `/healthz` returns 200 on all three services, deploy auto-triggers on push, migrations run, logs land in Axiom.

**Deliverables**:
- pnpm workspaces + Turborepo
- `apps/web` (Next.js 15 skeleton), `apps/api` (Fastify skeleton), `apps/voice` (WS stub)
- `packages/db` with Drizzle + one `health_checks` table + migration runner
- `packages/contracts` with ts-rest set up and one echo endpoint
- GitHub Actions: typecheck, test, build; auto-deploy to DO App Platform on push to main
- Axiom + Sentry wired in all three services
- `docker-compose.yml` for local dev aligned with DO services
- README with local dev instructions

**Out of scope**: auth, tenancy, any business logic.

---

## phase_tenancy_franchise

**Goal**: 4-level franchise hierarchy with RBAC and audit. Every later phase inherits this.

**Vertical slice**: a platform admin can create a franchisor, invite a franchisor admin, who invites a franchisee, who invites staff. Each user sees only their scoped data. Franchisor impersonation works and is audit-logged.

**Deliverables**:
- Better Auth schema + integration on `apps/api` and `apps/web`
- Tables: franchisors, franchisees, locations, users, memberships, audit_log
- Postgres RLS policies (defense in depth)
- `RequestScope` middleware on every API route
- Invitation flow: email → accept → role assignment
- Franchisor impersonation header + audit logging
- Seed script: Elevated Doors franchisor + one demo franchisee + one location + one user per role
- Comprehensive test suite: 401, 403, IDOR, privilege escalation, impersonation audit

**Depends on**: phase_foundation
**Out of scope**: customers, jobs, any trade-specific logic.

---

## phase_customer_job

**Goal**: Trade-agnostic customer and job CRUD with tenant isolation. The shape that every later feature reads from.

**Vertical slice**: a dispatcher can create a customer (with Google Places autocomplete), create a job for them, see it in a list, open its detail page, update its status.

**Deliverables**:
- Tables: customers, jobs, job_status_log, job_photos
- API: CRUD for customers and jobs; list, filter, search, pagination
- Web: customer list + detail, job list + detail (no board yet)
- Google Places API integration on customer form
- Status state machine (unassigned → scheduled → en_route → arrived → in_progress → completed | canceled)
- Photo upload to DO Spaces with presigned URLs
- Full test coverage including tenant IDOR

**Depends on**: phase_tenancy_franchise
**Out of scope**: dispatch UI, pricebook, tech mobile view, AI.

---

## phase_pricebook

**Goal**: Franchisor publishes pricebook templates; franchisees use them with optional overrides within floor/ceiling.

**Vertical slice**: Elevated Doors HQ publishes a garage-door starter catalog; demo franchisee's pricebook inherits all items; franchisee owner overrides price on one item and can't set it below floor.

**Deliverables**:
- Tables: service_catalog_templates, service_items, pricebook_overrides
- API: HQ endpoints to publish templates; franchisee endpoints to read resolved pricebook + write overrides
- Web: HQ template editor (platform_admin + franchisor_admin); franchisee pricebook view with override inline edit
- Garage-door seed catalog (installs, repairs, springs, openers, common parts)
- Validation: override must be within [floor, ceiling]; tests for boundary cases

**Depends on**: phase_tenancy_franchise
**Out of scope**: using the pricebook in quotes/invoices (that's later phases).

---

## phase_dispatch_board

**Goal**: Visual dispatch board with drag-drop assignment and live updates across sessions.

**Vertical slice**: dispatcher sees unassigned jobs in a left column and tech columns on the right, drags a job onto a tech, tech receives a notification; a second dispatcher in another browser sees the move within 2 seconds.

**Deliverables**:
- Web UI: columnar board, drag-drop (dnd-kit), filter by date/location/status
- API: assignment endpoint, SSE endpoint for live updates
- Basic static map on job detail (Google Maps embed with pins)
- Push notification groundwork (web push API wired; implementation stubs; real push in tech_mobile_pwa)
- Latency test: p95 of board update propagation <500ms under 10 concurrent sessions

**Depends on**: phase_customer_job
**Out of scope**: AI dispatch suggestions, mobile.

---

## phase_tech_mobile_pwa

**Goal**: Tech uses a phone to run their day offline-safely.

**Vertical slice**: tech installs PWA on phone, sees today's jobs, taps one, gets Google Maps directions, arrives (geolocation captured), starts job, takes 3 photos, adds line items from pricebook, generates invoice, closes job — all while in airplane mode for a bonus; syncs when back online.

**Deliverables**:
- Web service worker; installable PWA manifest
- Tech route set: `/tech`, `/tech/jobs/:id`, `/tech/jobs/:id/invoice`
- IndexedDB queue for writes; sync on reconnect
- Camera API for photo capture; upload to DO Spaces
- Line item picker tied to franchisee pricebook
- Invoice draft creation
- Web push notifications for new assignments
- Conflict strategy: last-write-wins for status; reject on constraint violation
- E2E: happy path on real iOS Safari + Chrome Android via Playwright + browserstack

**Depends on**: phase_dispatch_board, phase_pricebook
**Out of scope**: payment collection (next phase), AI photo-to-quote.

---

## phase_invoicing_stripe

**Goal**: Tech collects payment; Service.AI takes application fee; franchisee gets payout.

**Vertical slice**: tech taps "send invoice" → customer receives payment link + SMS → customer pays on their phone → application fee flows to Service.AI platform → net to franchisee's Stripe account → invoice marked paid on dispatch board within seconds via webhook.

**Deliverables**:
- Tables: invoices, invoice_line_items, payments, refunds
- Stripe Connect Standard onboarding flow (franchisee settings page)
- PaymentIntent creation with application_fee_amount (configurable flat 5% for now; royalty engine drives this in next phase)
- Stripe webhook handler (payment_intent.succeeded/failed, charge.refunded, account.updated)
- Invoice delivery: email (Resend) + SMS (Twilio) with payment link
- Refund flow
- Receipt generation (PDF via React-PDF)
- E2E with Stripe test mode

**Depends on**: phase_tech_mobile_pwa
**Out of scope**: royalty rule engine, AI collections.

---

## phase_royalty_engine

**Goal**: Royalty is automatic and reconcilable. Application fee on every charge reflects the active franchise agreement.

**Vertical slice**: franchisor admin configures "8% of gross revenue, min $500/month" for demo franchisee; 20 test jobs processed; at month-end a statement appears showing revenue, royalty, status; Transfer reconciles any difference.

**Deliverables**:
- Tables: franchise_agreements, royalty_rules, royalty_statements
- Rule engine (rule types: percentage, flat_per_job, tiered, minimum_floor — combinable)
- Rule resolves application_fee_amount at PaymentIntent creation
- Monthly statement job (BullMQ) — per-franchisee, end of franchisor's timezone
- Reconciliation via Stripe Transfers API
- Franchisor admin UI to author agreements + see statements
- Franchisee view: my royalty, my statements
- Tests: every rule type + combinations + edge cases (refunds, disputes, month boundaries, TZ)

**Depends on**: phase_invoicing_stripe
**Out of scope**: royalty tax handling; audit-trail PDFs for accountants (v1.5).

---

## phase_ai_csr_voice

**Goal**: AI answers the phone, books jobs, end-to-end.

**Vertical slice**: someone calls Elevated Doors' demo franchisee Twilio number → AI CSR greets with brand voice → collects name, address (via Google Places mid-call), door symptom → checks tech availability → books a job → customer gets SMS confirmation → job appears on dispatch board. All within 2 minutes of call start.

**Deliverables**:
- `apps/voice` Fastify WS server
- Twilio Media Streams handler (inbound/outbound µ-law 8kHz)
- Deepgram streaming ASR
- Claude intent loop with tool list: lookupCustomer, createCustomer, proposeTimeSlots, bookJob, transferToHuman, logCallSummary
- ElevenLabs TTS streaming back to Twilio
- Twilio phone provisioning flow on franchisee signup (area-code-matched local number)
- Call recording → DO Spaces
- AI guardrails: confidence threshold, transfer-to-human path, "undo" window on booked appointments
- `ai_conversations` + `ai_messages` + `call_sessions` persistence
- Test set: synthesized voice calls exercising each intent, plus adversarial inputs

**Depends on**: phase_dispatch_board, phase_customer_job
**Out of scope**: outbound calls, callbacks, voicemail handling.

---

## phase_ai_dispatcher

**Goal**: AI suggests tech assignments and (above confidence threshold) auto-assigns. Human dispatcher is supervisor, not operator.

**Vertical slice**: 10 unassigned jobs across a morning; AI looks at tech skills, current job queue, location; auto-assigns 7 (confidence >0.8); queues 3 for human review with reasoning; dispatcher one-clicks to approve.

**Deliverables**:
- Dispatcher agent in `packages/ai` with tools: listUnassignedJobs, listTechs, getTechCurrentLoad, computeTravelTime (Google Distance Matrix), proposeAssignment, applyAssignment
- Auto-apply above threshold; queue below with reasoning
- UI: "AI suggestions" column on dispatch board; one-click approve/reject
- Cancellation reflow: when a job is canceled, dispatcher agent auto-reflows affected assignments
- Metrics: % auto-applied, override rate, savings vs. manual baseline
- Tests for scheduling correctness (no double-booking, honoring skills, within travel budget)

**Depends on**: phase_dispatch_board
**Out of scope**: multi-objective optimization (revenue vs. travel); v1.5+.

---

## phase_ai_tech_assistant

**Goal**: Tech works faster and more accurately with AI help in the field.

**Vertical slice**: tech arrives, snaps photo of door → AI identifies make, model, failure mode → suggests 3 line items from franchisee pricebook, ordered by confidence → tech confirms → line items added to invoice. Also: tech speaks rough notes into phone → AI drafts customer-facing invoice description.

**Deliverables**:
- `tech.photoQuote` capability (Claude vision) with retrieval from garage-door KB + franchisee's pricebook
- `tech.notesToInvoice` capability (Claude text + TTS-safe formatting)
- RAG over `kb_docs` (pgvector) — seed with ~200 garage-door articles (brands, common failures, part cross-references)
- Mobile UI additions: "photo quote" button on job screen; "draft invoice from notes" prompt
- Telemetry: which suggestions accepted, which overridden (feeds eventual fine-tune pipeline)
- Guardrails: suggested quote above configured dollar cap requires tech or manager confirm

**Depends on**: phase_tech_mobile_pwa
**Out of scope**: full voice assistant for tech (v1.5).

---

## phase_ai_collections

**Goal**: AR aging shrinks without humans writing each follow-up.

**Vertical slice**: invoice hits day 7 past due → AI drafts friendly SMS + email → owner reviews in queue → approves or edits → sent. Day 14: firmer tone. Day 30: final notice. Payment retries on failed cards per schedule.

**Deliverables**:
- BullMQ scheduler for AR aging
- `collections.draft` capability with three tones (friendly/firm/final) parameterized by franchisee brand voice
- Review queue UI for owner/manager
- Payment retry orchestration (Stripe retries based on failure code)
- Franchisee config: auto-send vs. queue-for-approval, tone override, cadence override
- Metrics: DSO (days sales outstanding), recovered revenue from retries

**Depends on**: phase_invoicing_stripe
**Out of scope**: hard-collect escalation to human agents; v1.5.

---

## phase_franchisor_console

**Goal**: HQ can run the network — see every franchisee, review royalty, onboard new franchisees, audit any cross-tenant read.

**Vertical slice**: franchisor admin logs in → sees network dashboard (revenue by franchisee, jobs by franchisee, AI spend, NPS stub) → drills into one franchisee's data (audit log entry written) → reviews royalty statements → clicks "invite new franchisee" and runs through the onboarding wizard end-to-end.

**Deliverables**:
- `/franchisor` route set (web)
- Network metrics dashboard (aggregated, real-time via SSE)
- Franchisee drill-down with impersonation flow and on-screen "HQ viewing" banner
- Audit log viewer with search + filters
- New franchisee onboarding wizard: legal name → territory → Twilio number → Stripe Connect → pricebook template → first staff invite
- Pricebook template publisher UI (platform_admin + franchisor_admin)
- Franchise agreement authoring UI (terms JSON editor)

**Depends on**: phase_royalty_engine, phase_ai_csr_voice (for Twilio provisioning), phase_pricebook
**Out of scope**: per-franchisee AI tuning UI (franchisor can edit KB; per-franchisee guardrail UI is v1.5).

---

## Phase ordering rationale

- `foundation` and `tenancy_franchise` are strict prerequisites for everything.
- `customer_job` → `pricebook` unlocks the dispatch board and any pricing work.
- `dispatch_board` + `pricebook` → `tech_mobile_pwa` (tech needs jobs to do and pricebook to quote from).
- `tech_mobile_pwa` → `invoicing_stripe` → `royalty_engine` follows the payment data flow.
- AI phases are sequenced so CSR voice (biggest leverage) ships mid-build, tech assistant and dispatcher after their non-AI counterparts exist.
- `franchisor_console` is last because it depends on the most prior work and is primarily read-side.
