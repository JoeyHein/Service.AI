/**
 * CQA-07 — Customer acceptance public surface load scenario.
 *
 * Exercises the unauthenticated, token-gated customer flow: load the quote
 * summary, fetch the PDF, accept, and (when a deposit is due) request the
 * deposit intent. Unlike the SQB scenario this needs no session cookie —
 * the 32-byte accept token in the URL is the auth.
 *
 * Latency budgets (per the CQA gate):
 *   - p95 public GET summary  < 400 ms
 *   - p95 quote PDF render    < 1.5 s
 *   - p95 accept end-to-end   < 2.5 s (includes the BC convert hop)
 *   - 0 5xx, 0 timeouts
 *
 * Run (against a seeded staging stack):
 *   k6 run \
 *     -e API_BASE=https://api.staging.service.ai \
 *     -e TOKENS=tokenA,tokenB,tokenC \
 *     tests/perf/customer_acceptance.js
 *
 * Each VU picks a token from TOKENS (one committed+shared quote per token,
 * pre-seeded). Because accept is a one-way state transition, the scenario
 * only accepts once per token across the run; subsequent iterations exercise
 * the read paths (summary + PDF) and the idempotent deposit-intent.
 *
 * Environment knobs:
 *   API_BASE  — base URL of the Service.AI API (no trailing slash)
 *   TOKENS    — comma-separated accept tokens, one per pre-seeded quote
 *   VUS       — virtual user count (default 20)
 *   DURATION  — scenario duration (default 3m)
 */
import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const API_BASE = __ENV.API_BASE || 'http://localhost:3001';
const TOKENS = (__ENV.TOKENS || '').split(',').filter(Boolean);
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '3m';

const summaryLatency = new Trend('summary_latency_ms', true);
const pdfLatency = new Trend('pdf_latency_ms', true);
const acceptLatency = new Trend('accept_latency_ms', true);
const depositLatency = new Trend('deposit_intent_latency_ms', true);
const errors = new Counter('cqa_errors');

// One-shot accept guard, shared across iterations of the same VU.
const acceptedTokens = new Set();

export const options = {
  scenarios: {
    customers: { executor: 'constant-vus', vus: VUS, duration: DURATION },
  },
  thresholds: {
    summary_latency_ms: ['p(95)<400'],
    pdf_latency_ms: ['p(95)<1500'],
    accept_latency_ms: ['p(95)<2500'],
    http_req_failed: ['rate<0.01'],
    cqa_errors: ['count<1'],
  },
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function setup() {
  if (TOKENS.length === 0) {
    fail('env var TOKENS (comma-separated accept tokens) is required');
  }
}

export default function () {
  const token = TOKENS[Math.floor(Math.random() * TOKENS.length)];
  const base = `${API_BASE}/api/v1/public/quotes/${token}`;

  // 1. Summary (the page's first paint).
  let t0 = Date.now();
  const summary = http.get(base, { tags: { name: 'summary' }, timeout: '3s' });
  summaryLatency.add(Date.now() - t0);
  if (!check(summary, { 'summary 200': (r) => r.status === 200 })) {
    errors.add(1);
    return;
  }

  // 2. PDF (customer downloads / prints).
  t0 = Date.now();
  const pdf = http.get(`${base}/pdf`, { tags: { name: 'pdf' }, timeout: '5s' });
  pdfLatency.add(Date.now() - t0);
  if (pdf.status !== 200) errors.add(1);

  // 3. Accept once per token. The state machine rejects a second accept
  // with 409, which is expected — only count true 5xx as errors.
  if (!acceptedTokens.has(token)) {
    acceptedTokens.add(token);
    t0 = Date.now();
    const accept = http.post(`${base}/accept`, JSON.stringify({}), {
      headers: JSON_HEADERS,
      tags: { name: 'accept' },
      timeout: '8s',
    });
    acceptLatency.add(Date.now() - t0);
    if (accept.status >= 500) errors.add(1);

    // 4. Deposit intent (idempotent) when a deposit is due.
    const data = summary.json('data');
    if (data && data.depositAmountCents) {
      t0 = Date.now();
      const dep = http.post(`${base}/deposit-intent`, JSON.stringify({}), {
        headers: JSON_HEADERS,
        tags: { name: 'deposit-intent' },
        timeout: '5s',
      });
      depositLatency.add(Date.now() - t0);
      if (dep.status >= 500) errors.add(1);
    }
  }

  sleep(1);
}
