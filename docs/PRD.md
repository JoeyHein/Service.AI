# Service.AI — Product Requirements Document

## 1. Vision

An **AI-native field service platform** for trades, launched on garage doors, designed as a franchise platform from day one. AI is not a feature — it is the default worker in every role. Humans supervise, correct, and override.

Differentiator vs. ServiceTitan: built for franchises, with industry-specific AI that gets smarter across the network.

## 2. Success criteria (definition of done)

**v1 is done when Elevated Doors (US) runs their business on Service.AI end-to-end for one territory for 30 continuous days.** That means for that territory:

- All inbound service calls answered (AI CSR or human)
- All jobs dispatched through Service.AI's board
- All techs complete work via Service.AI's mobile PWA
- All invoices generated and collected via Stripe Connect
- Royalty owed to Elevated Doors HQ auto-calculated and statement produced
- No critical system outage >15 min; no data loss; no billing error >$1

Passing every phase gate is necessary but not sufficient. The 30-day pilot is the real gate.

## 3. User personas

### Platform-level
- **Platform admin** — Joey/Service.AI team. Creates franchisors, debugs, accesses all data, manages global AI configuration.

### Franchisor (Elevated Doors HQ)
- **Franchisor admin** — HQ operator. Onboards franchisees, sets pricebook floors, configures royalty rules, reviews network-wide metrics, reads any franchisee's data (audited).

### Franchisee (individual franchise owner)
- **Franchisee owner** — owns one or more territories. Configures locations, hires staff, sets local pricing within franchisor floors, sees own P&L.
- **Location manager** — runs one territory day-to-day. Manages dispatcher/tech/CSR staff.
- **Dispatcher** — assigns jobs to techs, monitors board, handles escalations from AI dispatcher.
- **Tech** — installs/services garage doors. Uses mobile PWA in the field. AI assists with parts lookup, quoting from photos, invoicing.
- **CSR** — handles phone calls AI can't (complex cases, escalations). Reviews AI-booked appointments flagged for approval.

### Customer-facing
- **Customer** — homeowner or business. Receives invoices, pays online, sees job history. Self-service portal in v1.5+.

## 4. Core v1 workflows

### 4.1 AI CSR intake (highest-leverage AI win)
1. Customer calls franchisee's Twilio number.
2. AI CSR (Claude + Deepgram + ElevenLabs) answers, greets with franchisee's brand.
3. Identifies intent: new install quote, service call, reschedule, billing question, transfer-to-human.
4. Captures name, address (via Google Places), door type/issue, preferred time.
5. Checks tech availability and offers 2-3 time slots.
6. Confirms booking and creates customer + job records.
7. SMS confirmation to customer; job appears on dispatch board.
8. If AI confidence low, transfers to human CSR.

### 4.2 Dispatch
1. New jobs land on board (unassigned column).
2. AI dispatcher analyzes tech skills, location, load, job requirements → suggests assignment.
3. Human dispatcher approves (one click) or overrides.
4. Job moves to tech's column; tech gets push notification in PWA.
5. Drag-drop reassignment at any time; cancellations reflow automatically.

### 4.3 Tech in the field
1. Tech opens PWA; sees today's jobs.
2. Navigates to job (Google Maps deep link).
3. Taps "Arrived" → geolocation confirmed.
4. Takes photo of door → AI Vision identifies make/model/issue → suggests line items from franchisee pricebook.
5. Tech confirms/adjusts line items.
6. Does the work. Takes photos of completion.
7. Generates invoice from line items; shows to customer.
8. Customer pays on tech's device (Stripe Terminal or Payment Link).
9. Tech marks job complete; syncs when online.

### 4.4 Office / collections
1. Unpaid invoices age.
2. AI collections assistant drafts follow-up (email + SMS), schedules escalating reminders.
3. Owner/manager reviews AI actions in a queue; confirms/edits.
4. Payment received → Stripe Connect auto-splits: franchisee bank account gets net, Service.AI platform account gets application fee (includes franchisor royalty).

### 4.5 Royalty & reconciliation
1. Franchise agreement defines royalty rule (% of revenue, flat per-job, tiered, min floor).
2. Every Stripe charge sets `application_fee_amount` per rule.
3. Monthly statement generated per franchisee: revenue, royalty owed, adjustments, balance.
4. Stripe Transfers API reconciles platform → franchisor payout.

### 4.6 Franchise onboarding
1. Franchisor admin invites a new franchisee (email).
2. Franchisee accepts, signs franchise agreement (DocuSign embed — v1.5, simpler e-sign in v1).
3. Franchisee completes Stripe Connect onboarding.
4. Franchisee picks territory (ZIP codes); Twilio number auto-provisioned for the area code.
5. Pricebook cloned from franchisor template.
6. Franchisee invites staff; staff provision own logins via Better Auth.

## 5. Must-haves (v1)

- 4-role loop (CSR/dispatch/tech/office) end-to-end for garage door service & install jobs
- AI-first on all 4 roles, with human-override queues and configurable guardrails per franchisee
- Multi-provider AI routing (Claude + Grok), three-layer learning (domain KB + franchisee memory + HQ aggregate)
- 4-level franchise tenancy with franchisor read-everything (audited)
- Stripe Connect Standard with royalty engine
- PWA for techs, web for office
- Better Auth with 7 role types
- Google Maps (Places + routing)
- Twilio provisioned numbers per franchisee, BYO forwarding option
- Single-territory production use by Elevated Doors for 30 days

## 6. Deferred (v1.5 / v2)

- React Native native mobile app (v2)
- Customer self-service portal (v1.5)
- Memberships / recurring plans
- Inventory & truck stock
- Payroll / spiffs / commissions
- Marketing automation / review campaigns
- Call recording search & analytics
- DocuSign integration for franchise agreements (use simpler e-sign in v1)
- HQ fine-tune pipeline across franchisees (we collect data in v1 but training happens later)
- Multi-trade expansion (architecture ready, packs not shipped)
- BC / ERP integration (API is ERP-agnostic; external portal handles this later)
- Offline-mode conflict resolution beyond queue-and-sync
- Native iOS/Android builds of the PWA via Capacitor

## 7. Non-goals

- Replacing ServiceTitan feature-for-feature. We are 10% of the surface, 10x the AI.
- Building in public. Elevated Doors is a closed pilot until v1 is complete.
- Supporting tenants outside franchise model. Every account is either franchisor, franchisee, location, or user of one of those.
- Accepting the job if franchisee lacks Stripe Connect. No Stripe = no Service.AI.
- Phone hardware. We integrate Twilio; franchisee brings a phone/softphone.

## 8. Constraints

- **Data residency**: US region (franchise is US-based). DO App Platform NYC or SFO region.
- **PCI**: We never store card data. Stripe Elements / Payment Links only.
- **PII**: Customer addresses, phone numbers stored; encrypted at rest via DO Managed Postgres.
- **Call recordings**: retain 90 days in Twilio + S3-compatible (DO Spaces), franchisee-accessible.
- **Compliance**: SOC 2 not in scope for v1, but build the audit-log + access-control foundation that makes SOC 2 a quarter-long add-on later.
- **Uptime target**: 99.5% for v1 (not 99.9%). A 30-day pilot at 99.5% = 3.6h max downtime.

## 9. Pricing (Service.AI → franchisor)

Not a v1 build concern — we handle this via a contract with Elevated Doors. Likely model: per-franchisee per-month + AI usage pass-through + implementation fee. Billing feature for this is v2.
