/**
 * SQB-11 redaction tests.
 *
 * Asserts that the shared pino logger does not emit the
 * `X-Service-AI-Key` header to any sink. The redact list in
 * `apps/api/src/logger.ts` covers the header in three shapes — inbound
 * (`req.headers`), outbound (`res.headers`), and provider call
 * details — because the BC AI Agent provider sends the key as an
 * HTTP header rather than as a body field.
 *
 * The test captures stdout from a fresh pino instance built with the
 * same config and asserts the literal plaintext key never lands on
 * disk.
 */
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pino } from 'pino';

/**
 * Build a pino instance with the same redact policy as
 * `apps/api/src/logger.ts`. We don't import the production logger
 * because that one writes to its own transport (potentially Axiom)
 * and we want a captive sink to inspect.
 */
function makeLogger(sink: Writable): ReturnType<typeof pino> {
  return pino(
    {
      level: 'info',
      redact: {
        // Keep in sync with apps/api/src/logger.ts.
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-service-ai-key"]',
          'res.headers["x-service-ai-key"]',
          '*.authorization',
          'authorization',
          '*.apiKey',
          '*.api_key',
          '*["x-service-ai-key"]',
          '*.*["x-service-ai-key"]',
          '*.*.*["x-service-ai-key"]',
          '*.xServiceAiKey',
          '*.*.xServiceAiKey',
          '*.*.*.xServiceAiKey',
          '*.*.apiKey',
          '*.*.*.apiKey',
          '*.*.api_key',
          '*.*.*.api_key',
        ],
        censor: '[REDACTED]',
      },
    },
    sink,
  );
}

function captureOutput(): {
  sink: Writable;
  output: () => string;
} {
  const buf: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  return {
    sink,
    output: () => Buffer.concat(buf).toString('utf8'),
  };
}

const SECRET = 'sai_live_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf';

describe('SQB-11 pino redaction', () => {
  it('redacts X-Service-AI-Key on a req.headers object', () => {
    const { sink, output } = captureOutput();
    const log = makeLogger(sink);
    log.info({
      req: {
        headers: {
          'x-service-ai-key': SECRET,
          'user-agent': 'test',
        },
      },
    }, 'inbound');
    const text = output();
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[REDACTED]');
  });

  it('redacts the same header in an outbound res.headers object', () => {
    const { sink, output } = captureOutput();
    const log = makeLogger(sink);
    log.info({
      res: { headers: { 'x-service-ai-key': SECRET } },
    }, 'outbound');
    expect(output()).not.toContain(SECRET);
  });

  it('redacts apiKey / api_key on arbitrary nested objects', () => {
    const { sink, output } = captureOutput();
    const log = makeLogger(sink);
    log.info({ supplier: { apiKey: SECRET, api_key: SECRET } }, 'config dump');
    expect(output()).not.toContain(SECRET);
  });

  it('redacts xServiceAiKey camelCase property', () => {
    const { sink, output } = captureOutput();
    const log = makeLogger(sink);
    log.info({ provider: { xServiceAiKey: SECRET } }, 'provider config');
    expect(output()).not.toContain(SECRET);
  });

  it('redacts when the header appears bracket-keyed under any parent', () => {
    const { sink, output } = captureOutput();
    const log = makeLogger(sink);
    log.info(
      {
        outbound: { 'x-service-ai-key': SECRET },
      },
      'arbitrary parent',
    );
    expect(output()).not.toContain(SECRET);
  });

  it('redacts the header when deeply nested (TD-SQB-A7)', () => {
    const { sink, output } = captureOutput();
    const log = makeLogger(sink);
    // The realistic leak path the single-star glob missed:
    // a logged provider config object two levels deep.
    log.info(
      { supplier: { config: { 'x-service-ai-key': SECRET } } },
      'nested provider config',
    );
    expect(output()).not.toContain(SECRET);
  });

  it('redacts xServiceAiKey + apiKey when deeply nested (TD-SQB-A7)', () => {
    const { sink, output } = captureOutput();
    const log = makeLogger(sink);
    log.info(
      {
        ctx: { supplier: { xServiceAiKey: SECRET } },
        other: { provider: { apiKey: SECRET } },
      },
      'nested camelCase + apiKey',
    );
    expect(output()).not.toContain(SECRET);
  });

  it('does NOT redact unrelated fields (sanity check)', () => {
    const { sink, output } = captureOutput();
    const log = makeLogger(sink);
    log.info({ supplier: { name: 'BC AI Agent', endpointUrl: 'https://portal.opendc.ca' } }, 'public config');
    expect(output()).toContain('BC AI Agent');
    expect(output()).toContain('https://portal.opendc.ca');
    expect(output()).not.toContain('[REDACTED]');
  });
});
