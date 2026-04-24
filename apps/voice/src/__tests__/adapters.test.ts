/**
 * Unit tests for telephony + ASR + TTS stubs (TASK-CV-04).
 */

import { describe, expect, it } from 'vitest';
import { stubTelephonyClient, strictStubTelephonyClient } from '../telephony.js';
import { stubAsrClient } from '../asr.js';
import { stubTtsClient } from '../tts.js';

describe('CV-04 / telephony stub', () => {
  it('provisions a stable E.164 number for a given franchiseeId', async () => {
    const t = stubTelephonyClient();
    const a = await t.provisionNumber({ franchiseeId: 'fe-1' });
    const b = await t.provisionNumber({ franchiseeId: 'fe-1' });
    expect(a.phoneNumberE164).toBe(b.phoneNumberE164);
    expect(a.phoneNumberE164).toMatch(/^\+1555\d{7}$/);
    expect(a.twilioSid).toMatch(/^PN/);
  });

  it('different franchisees get different numbers', async () => {
    const t = stubTelephonyClient();
    const a = await t.provisionNumber({ franchiseeId: 'fe-a' });
    const b = await t.provisionNumber({ franchiseeId: 'fe-b' });
    expect(a.phoneNumberE164).not.toBe(b.phoneNumberE164);
  });

  it('area code override honoured', async () => {
    const t = stubTelephonyClient();
    const r = await t.provisionNumber({ franchiseeId: 'fe-1', areaCode: '720' });
    expect(r.phoneNumberE164).toMatch(/^\+1720\d{7}$/);
  });

  it('signature verify passes for stub, rejects for strict stub', () => {
    const t = stubTelephonyClient();
    const s = strictStubTelephonyClient();
    const input = { url: 'https://x.test', params: { a: '1' }, signature: 'sig' };
    expect(t.verifyWebhookSignature(input)).toBe(true);
    expect(s.verifyWebhookSignature(input)).toBe(false);
  });

  it('sendSms returns a SM* sid', async () => {
    const t = stubTelephonyClient();
    const r = await t.sendSms({ to: '+1', from: '+2', body: 'hi' });
    expect(r.sid).toMatch(/^SM/);
  });
});

describe('CV-04 / ASR stub', () => {
  it('emits the canned transcript after enough audio chunks', async () => {
    const asr = stubAsrClient({
      scripts: { call1: ['Hi I need a tech', 'Denver'] },
    });
    const session = await asr.open({ audioId: 'call1' });
    const events: Array<{ text: string }> = [];
    session.onEvent((e) => {
      if (e.kind === 'final') events.push({ text: e.text });
    });
    for (let i = 0; i < 6; i++) session.pushAudio(Buffer.alloc(160));
    await session.close();
    expect(events.map((e) => e.text)).toEqual(['Hi I need a tech', 'Denver']);
  });

  it('default script is used when audioId is not mapped', async () => {
    const asr = stubAsrClient({ defaultScript: ['Hello'] });
    const session = await asr.open({});
    const events: string[] = [];
    session.onEvent((e) => {
      if (e.kind === 'final') events.push(e.text);
    });
    for (let i = 0; i < 3; i++) session.pushAudio(Buffer.alloc(160));
    expect(events).toEqual(['Hello']);
  });
});

describe('CV-04 / TTS stub', () => {
  it('emits silent frames roughly proportional to the text length', async () => {
    const tts = stubTtsClient();
    const short = tts.speak({ text: 'Hi' });
    const long = tts.speak({ text: 'Hi '.repeat(40) });
    let shortCount = 0;
    let longCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of short.chunks) shortCount++;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of long.chunks) longCount++;
    expect(longCount).toBeGreaterThan(shortCount);
  });
});
