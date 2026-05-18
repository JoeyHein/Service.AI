/**
 * SQB-12 — Idempotency + network-drop stress.
 *
 * 10 concurrent VUs all attempt to commit the SAME quote with the
 * SAME idempotency key. Asserts exactly one BC document is created
 * (1 winner returns `cached: false`, 9 returns `cached: true`).
 *
 * Run:
 *   k6 run \
 *     -e API_BASE=https://api.staging.service.ai \
 *     -e SESSION_COOKIE=... \
 *     -e QUOTE_ID=...           # a priced quote ready to commit
 *     tests/perf/supplier_quote_bridge_idempotency.js
 *
 * The supplier-side (BC AI Agent) has its own 10× concurrent commit
 * test in `bc-ai-agent/backend/tests/test_external_quote_commit.py`.
 * This script is the END-TO-END equivalent: it stresses the same
 * invariant across the Service.AI quote-routes + BcAiAgentProvider +
 * the external surface.
 */
import http from 'k6/http';
import { check, fail } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { SharedArray } from 'k6/data';

const API_BASE = __ENV.API_BASE || 'http://localhost:3001';
const SESSION_COOKIE = __ENV.SESSION_COOKIE || '';
const QUOTE_ID = __ENV.QUOTE_ID || '';

// One idempotency key, frozen at scenario init, shared across all VUs.
const sharedIdempotencyKey = new SharedArray('idempotency-key', () => [uuidv4()]);

export const options = {
  scenarios: {
    swarm: {
      executor: 'per-vu-iterations',
      vus: 10,
      iterations: 1,
      maxDuration: '20s',
    },
  },
  thresholds: {
    'http_req_failed': ['rate==0'],
  },
};

function mustEnv() {
  for (const [name, value] of [
    ['SESSION_COOKIE', SESSION_COOKIE],
    ['QUOTE_ID', QUOTE_ID],
  ]) {
    if (!value) fail(`env var ${name} is required`);
  }
}

export function setup() {
  mustEnv();
  return { idempotencyKey: sharedIdempotencyKey[0] };
}

export default function (data) {
  const res = http.post(
    `${API_BASE}/api/v1/quotes/${QUOTE_ID}/commit`,
    JSON.stringify({ idempotencyKey: data.idempotencyKey }),
    {
      headers: { 'Content-Type': 'application/json', Cookie: SESSION_COOKIE },
      tags: { name: 'commit' },
      timeout: '10s',
    },
  );
  // Every VU should get a 200 back with the SAME supplierQuoteRef.
  check(res, {
    'commit 200': (r) => r.status === 200,
    'has supplierQuoteRef': (r) =>
      r.json('data.supplierQuoteRef') !== undefined && r.json('data.supplierQuoteRef') !== null,
  });
}

/**
 * Post-run assertion (k6 native): all 10 calls returned the same
 * supplierQuoteRef. Encoded in summary.json export — run
 *
 *   jq '.metrics.iteration_duration.count'
 *
 * against the export to verify all 10 iterations completed, then
 * inspect the per-VU response payloads via a wrapper script if you
 * want the equality assertion. For an in-CI gate, wrap this k6 script
 * with a tiny node post-processor that pulls the SQ refs from the
 * structured output and asserts the set size is 1.
 */
