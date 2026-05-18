# Service.AI perf scenarios

k6 scripts that exercise the load-bearing performance budgets the
gate docs commit to. These run against **staging**, not local dev —
they need a reachable Service.AI API + a reachable BC AI Agent +
seed data the script can drive.

## Setup

1. Install k6: https://k6.io/docs/get-started/installation/
2. Get a manager session cookie:
   ```bash
   curl -sX POST https://api.staging.service.ai/api/auth/sign-in/email \
     -H 'content-type: application/json' \
     -d '{"email":"manager@elevated.test","password":"…"}' \
     -i | grep -i set-cookie
   ```
3. Pull the seed ids:
   ```bash
   psql $STAGING_DATABASE_URL -c "
     SELECT id FROM branches LIMIT 1;
     SELECT id FROM suppliers LIMIT 1;
     SELECT id FROM customers LIMIT 1;
   "
   ```

## Scenarios

### `supplier_quote_bridge_live.js`

20 CSRs holding live quote builders, debounced re-pricing every 1.5s
for 5 minutes, then commit. Asserts:

* p95 `priceItems` < 1.0s end-to-end (Service.AI → BC AI Agent → BC → back)
* p95 `commitQuote` < 2.5s end-to-end
* 0 5xx, 0 timeouts

```bash
k6 run \
  -e API_BASE=https://api.staging.service.ai \
  -e SESSION_COOKIE='better-auth.session_token=…' \
  -e BRANCH_ID=… \
  -e SUPPLIER_ID=… \
  -e CUSTOMER_ID=… \
  tests/perf/supplier_quote_bridge_live.js
```

### `supplier_quote_bridge_idempotency.js`

10 concurrent VUs commit the same priced quote with the same
idempotency key. Asserts every VU gets a 200 with a populated
`supplierQuoteRef`; the BC-side invariant (one document, nine
cached replays) is asserted by `bc-ai-agent/backend/tests/
test_external_quote_commit.py::TestConcurrency` against a stubbed
BC client. This script is the wire-level end-to-end version.

```bash
k6 run \
  -e API_BASE=https://api.staging.service.ai \
  -e SESSION_COOKIE='…' \
  -e QUOTE_ID='<a priced quote id>' \
  tests/perf/supplier_quote_bridge_idempotency.js
```

## Acceptance gates

The `thresholds` block in each scenario fails the run with a non-zero
exit code if a budget is missed. Wire into CI by checking k6's exit
status; no extra parsing required.
