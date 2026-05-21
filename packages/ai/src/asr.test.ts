import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Deepgram SDK so the adapter can be exercised without a live WS.
let transcriptHandler: ((data: unknown) => void) | undefined;
const fakeConn = {
  on: (event: string, fn: (data: unknown) => void) => {
    if (event === 'Transcript') transcriptHandler = fn;
  },
  getReadyState: () => 1,
  send: vi.fn(),
  requestClose: vi.fn(),
};

vi.mock('@deepgram/sdk', () => ({
  createClient: () => ({ listen: { live: () => fakeConn } }),
  LiveTranscriptionEvents: { Transcript: 'Transcript', UtteranceEnd: 'UtteranceEnd', Error: 'Error' },
}));

import { deepgramAsrClient, stubAsrClient, type AsrEvent } from './asr.js';

beforeEach(() => {
  transcriptHandler = undefined;
  fakeConn.send.mockClear();
});

describe('deepgramAsrClient', () => {
  it('maps interim → partial and final → final with a monotonic seq', async () => {
    const session = await deepgramAsrClient('dg_key').open({});
    const events: AsrEvent[] = [];
    session.onEvent((e) => events.push(e));

    transcriptHandler!({
      channel: { alternatives: [{ transcript: 'hello', confidence: 0.8 }] },
      is_final: false,
    });
    transcriptHandler!({
      channel: { alternatives: [{ transcript: 'hello there', confidence: 0.95 }] },
      is_final: true,
    });
    transcriptHandler!({
      channel: { alternatives: [{ transcript: 'next turn', confidence: 0.9 }] },
      is_final: true,
    });

    expect(events[0]).toEqual({ kind: 'partial', text: 'hello', confidence: 0.8 });
    expect(events[1]).toEqual({ kind: 'final', text: 'hello there', confidence: 0.95, seq: 1 });
    expect(events[2]).toEqual({ kind: 'final', text: 'next turn', confidence: 0.9, seq: 2 });
  });

  it('ignores empty transcripts', async () => {
    const session = await deepgramAsrClient('dg_key').open({});
    const events: AsrEvent[] = [];
    session.onEvent((e) => events.push(e));
    transcriptHandler!({ channel: { alternatives: [{ transcript: '' }] }, is_final: true });
    expect(events).toHaveLength(0);
  });

  it('pushAudio forwards frames to the live connection when open', async () => {
    const session = await deepgramAsrClient('dg_key').open({});
    session.pushAudio(Buffer.from([1, 2, 3, 4]));
    expect(fakeConn.send).toHaveBeenCalledTimes(1);
  });

  it('close requests connection close', async () => {
    const session = await deepgramAsrClient('dg_key').open({});
    await session.close();
    expect(fakeConn.requestClose).toHaveBeenCalled();
  });
});

describe('stubAsrClient (unchanged fallback)', () => {
  it('still emits canned finals from a default script', async () => {
    const session = await stubAsrClient({ defaultScript: ['hi there'] }).open({});
    const events: AsrEvent[] = [];
    session.onEvent((e) => events.push(e));
    session.pushAudio(Buffer.alloc(160));
    session.pushAudio(Buffer.alloc(160));
    session.pushAudio(Buffer.alloc(160));
    expect(events.some((e) => e.kind === 'final' && e.text === 'hi there')).toBe(true);
  });
});
