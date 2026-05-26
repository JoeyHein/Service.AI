# W0 — Workflow-Fit Checklist (Elevated Doors)

Purpose: catch "the software does X, but we actually do Y" **before** go-live,
when it's cheap to fix. For each stage below, the **"Service.AI does"** line is
pre-filled. You fill the **"Reality"** line with how Elevated Doors actually
works, and the **"Verdict"** with one of:

- `OK` — matches, no change
- `FIX-NOW` — must change before the pilot
- `FIX-LATER` — change during the 30-day pilot
- `WONTFIX-v1` — live with it for the pilot

Don't overthink it — short notes are fine. Anything marked `FIX-NOW` becomes a
tracked task and gets done before Wave 1.

---

## 1. Inbound call / lead intake
- **Service.AI does:** CSR (human in Wave 1) takes the call and creates a
  customer + books a job. Customer captured by name/phone/email/address; phone
  number is the CRM match key. (Wave 2: AI answers and books directly.)
- **Reality:** _______________________________________________
- **Specifics to confirm:** Where do leads come from (phone, web form, repeat,
  referral)? Do you capture anything beyond name/phone/address at first call
  (gate code, dog, callback window, urgency)?
- **Verdict:** ____

## 2. Qualifying / triage
- **Service.AI does:** free-text job title + description + call notes attached
  to the customer; the tech sees these on the job screen.
- **Reality:** _______________________________________________
- **Specifics:** Do you classify jobs (repair vs install vs service)? Is there
  info you decide pricing/dispatch on at this stage?
- **Verdict:** ____

## 3. Quoting
- **Service.AI does:** build a quote from the shared corporate pricebook; line
  prices come from **real BC** (cost) × margin engine (line → category →
  corporate default). Manager+ can override margin (reason required). Quote has
  a status machine (draft → priced → committed).
- **Reality:** _______________________________________________
- **Specifics:** Do you quote on the phone, on-site, or both? How do you price
  today (BC, spreadsheet, gut)? How often do you discount/override? Are there
  job types you *can't* quote from a catalog (custom)?
- **Verdict:** ____

## 4. Sending the quote to the customer
- **Service.AI does:** "Share" mints a signed link; customer opens a public
  page (no login), sees the quote (never cost/margin), accepts, and pays a
  deposit via Stripe. **Wave 1: link delivered by copy-paste** (auto email/SMS
  is Wave 2).
- **Reality:** _______________________________________________
- **Specifics:** How do customers approve today (verbal, email, signature)? Do
  you take a deposit? What %/amount? Is a PDF expected?
- **Verdict:** ____

## 5. Deposit / payment terms
- **Service.AI does:** deposit amount is a server-frozen policy on the
  corporate record; customer pays it on the accept page; balance is invoiced
  after the job. Single corporate Stripe account.
- **Reality:** _______________________________________________
- **Specifics:** Deposit policy (flat, %, none)? Do some customers pay in full
  up front? Net-terms / on-account customers?
- **Verdict:** ____

## 6. Order placement (supplier / BC)
- **Service.AI does:** committing a quote creates an `SQ-XXXXXX` in BC;
  customer acceptance converts it to an `SO-XXXXXX` order in BC automatically.
- **Reality:** _______________________________________________
- **Specifics:** When do you actually order materials today — at quote, at
  accept, or at schedule? Anything ordered outside BC?
- **Verdict:** ____

## 7. Scheduling
- **Service.AI does:** accepted quote auto-creates an `unassigned` job; you
  schedule it (date/time window).
- **Reality:** _______________________________________________
- **Specifics:** How far out do you book? Time windows or exact times? Who owns
  the calendar? Any install-vs-service scheduling difference?
- **Verdict:** ____

## 8. Dispatch / assignment
- **Service.AI does:** dispatch board; assign a tech to a job (manual in Wave
  1; AI suggestions use distance/load, Wave 2). Tech sees assigned jobs on the
  Today screen.
- **Reality:** _______________________________________________
- **Specifics:** How many techs in the pilot branch? How do you decide who goes
  where (skill, area, van stock)? Same-day / emergency handling?
- **Verdict:** ____

## 9. On-site (tech app)
- **Service.AI does:** tech PWA shows the job, customer + call notes,
  tap-to-call, directions, photo capture, on-site **photo-quote** (vision AI)
  for upsell, start/complete status, create invoice.
- **Reality:** _______________________________________________
- **Specifics:** What do techs carry today (paper, phone, tablet)? Do they
  upsell / requote on-site? Do they collect payment in the field?
- **Verdict:** ____

## 10. Completion → balance invoice
- **Service.AI does:** completing the job auto-drafts the balance invoice from
  the quote lines minus the deposit credit; office finalizes + sends.
- **Reality:** _______________________________________________
- **Specifics:** Who finalizes invoices (tech or office)? Do final materials/
  labor differ from the quote often (change orders)?
- **Verdict:** ____

## 11. Collections
- **Service.AI does:** AI drafts follow-up email/SMS (tone/escalation),
  human-approves before send (0.90 guardrail). **Wave 1: manual; auto-send is
  Wave 2.**
- **Reality:** _______________________________________________
- **Specifics:** How do you chase unpaid balances today? Typical terms? When
  does something become "overdue"?
- **Verdict:** ____

## 12. Manager commission / comp
- **Service.AI does:** commission is credited **once, at quote commit** (flat %
  of committed quote), to the branch manager; voiding reverses it. Manager sees
  it on the branch dashboard.
- **Reality:** _______________________________________________
- **Specifics:** Is the pilot branch run by a W2 manager on base + commission?
  What's the commission basis (quote total, margin, collected)? Pay cadence?
- **Verdict:** ____

## 13. Roles & who-does-what
- **Service.AI does:** roles corporate_admin / manager / dispatcher / tech /
  csr (+ accounting/api). Corporate sees all branches; branch users pinned to
  one branch.
- **Reality:** _______________________________________________
- **Specifics:** Who are the real people in the pilot, and which role each?
  (Names → emails → roles for seeding.)
- **Verdict:** ____

## 14. Reporting / what you watch
- **Service.AI does:** branch dashboard (jobs, revenue, commission), corporate
  overview across branches.
- **Reality:** _______________________________________________
- **Specifics:** What numbers do you check daily/weekly today? Anything you'd
  need on day one of the pilot that isn't here?
- **Verdict:** ____

---

## 15. Anything else
Flows, edge cases, or "the way we do it" details not covered above:
- _______________________________________________
- _______________________________________________

---

_Fill this in (rough is fine), and I'll turn every `FIX-NOW` into a tracked
task and knock them out before Wave 1. `FIX-LATER` items get scheduled into the
30-day window._
