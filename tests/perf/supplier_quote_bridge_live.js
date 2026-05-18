/**
 * SQB-12 — Supplier quote bridge live load scenario.
 *
 * Exercises the read-heavy side of the live-quote UI under sustained
 * concurrency. 20 virtual CSRs hold an open quote, debounce-re-price
 * every 1.5s for 5 minutes, then commit once. Mirrors the live
 * keystroke-driven workload described in the SQB gate.
 *
 * Latency budgets (per the gate doc):
 *   - p95 `priceItems` end-to-end (Service.AI → BC AI Agent → BC → back) < 1.0 s
 *   - p95 `commitQuote` end-to-end < 2.5 s
 *   - 0 5xx, 0 timeouts
 *
 * Run:
 *   k6 run \
 *     -e API_BASE=https://api.staging.service.ai \
 *     -e SESSION_COOKIE=... \
 *     -e BRANCH_ID=... \
 *     -e SUPPLIER_ID=... \
 *     -e CUSTOMER_ID=... \
 *     tests/perf/supplier_quote_bridge_live.js
 *
 * Environment knobs:
 *   API_BASE        — base URL of the Service.AI API (no trailing slash)
 *   SESSION_COOKIE  — cookie header for the authenticated manager user
 *   BRANCH_ID       — branch UUID the manager is scoped to
 *   SUPPLIER_ID     — suppliers.id row used by /quotes POST
 *   CUSTOMER_ID     — pre-seeded customer (use the demo seed's "Acme Doors")
 *   VUS             — override virtual user count (default 20)
 *   DURATION        — override scenario duration (default 5m)
 */
import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const API_BASE = __ENV.API_BASE || 'http://localhost:3001';
const SESSION_COOKIE = __ENV.SESSION_COOKIE || '';
const BRANCH_ID = __ENV.BRANCH_ID || '';
const SUPPLIER_ID = __ENV.SUPPLIER_ID || '';
const CUSTOMER_ID = __ENV.CUSTOMER_ID || '';

const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '5m';

const priceLatency = new Trend('price_latency_ms', true);
const commitLatency = new Trend('commit_latency_ms', true);
const priceErrors = new Counter('price_errors');
const commitErrors = new Counter('commit_errors');

export const options = {
  scenarios: {
    csrs: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    // Hard gates from the gate doc.
    'price_latency_ms': ['p(95)<1000'],
    'commit_latency_ms': ['p(95)<2500'],
    'http_req_failed': ['rate<0.01'],
    'price_errors': ['count<1'],
    'commit_errors': ['count<1'],
  },
};

const HEADERS = {
  'Content-Type': 'application/json',
  Cookie: SESSION_COOKIE,
};

const STUB_CATALOG = [
  'GD-STEEL-9X7-INS',
  'GD-STEEL-10X8-INS',
  'GD-STEEL-16X7-INS',
  'GD-ALUM-16X7-FV',
  'OP-LM-8500W',
  'OP-LM-8160W',
  'SPR-TORSION-KIT',
  'HK-02',
  'HK-03',
];

function randomLines() {
  // Each CSR builds a 2-4-line basket of randomly picked SKUs.
  const n = 2 + Math.floor(Math.random() * 3);
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push({
      sku: STUB_CATALOG[Math.floor(Math.random() * STUB_CATALOG.length)],
      quantity: 1 + Math.floor(Math.random() * 5),
    });
  }
  return lines;
}

function mustEnv() {
  for (const [name, value] of [
    ['SESSION_COOKIE', SESSION_COOKIE],
    ['BRANCH_ID', BRANCH_ID],
    ['SUPPLIER_ID', SUPPLIER_ID],
    ['CUSTOMER_ID', CUSTOMER_ID],
  ]) {
    if (!value) {
      fail(`env var ${name} is required for this scenario`);
    }
  }
}

export function setup() {
  mustEnv();
}

export default function () {
  // 1. Create a draft. Each VU creates its own quote per iteration.
  const createRes = http.post(
    `${API_BASE}/api/v1/quotes`,
    JSON.stringify({
      customerId: CUSTOMER_ID,
      supplierId: SUPPLIER_ID,
    }),
    { headers: HEADERS, tags: { name: 'create' } },
  );
  if (
    !check(createRes, {
      'create 201': (r) => r.status === 201,
    })
  ) {
    return;
  }
  const quote = createRes.json('data');
  const quoteId = quote && quote.id;
  if (!quoteId) return;

  // 2. Debounced re-pricing loop. Hold for ~30s of natural typing
  // (20 keystrokes at 1.5s intervals) to mimic a real configuration
  // session.
  for (let i = 0; i < 20; i += 1) {
    const lines = randomLines();
    const t0 = Date.now();
    const res = http.post(
      `${API_BASE}/api/v1/quotes/${quoteId}/price`,
      JSON.stringify({ lineItems: lines }),
      { headers: HEADERS, tags: { name: 'price' }, timeout: '5s' },
    );
    priceLatency.add(Date.now() - t0);
    if (res.status !== 200) {
      priceErrors.add(1);
    }
    sleep(1.5);
  }

  // 3. Commit once at the end. Provide our own idempotency key so a
  // retry under k6's restart-on-failure semantics still collapses.
  const idempotencyKey = uuidv4();
  const t0 = Date.now();
  const commitRes = http.post(
    `${API_BASE}/api/v1/quotes/${quoteId}/commit`,
    JSON.stringify({ idempotencyKey }),
    { headers: HEADERS, tags: { name: 'commit' }, timeout: '8s' },
  );
  commitLatency.add(Date.now() - t0);
  if (commitRes.status !== 200) {
    commitErrors.add(1);
  }
}
