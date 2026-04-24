/**
 * Pluggable vision adapter (phase_ai_tech_assistant).
 *
 * `VisionClient.identify({ imageRef })` returns structured tags
 * the photoQuote pipeline can feed straight into the RAG
 * retriever. `imageRef` is an opaque string the caller
 * understands — in production it's a DO Spaces storage key; the
 * stub just looks up a fixture table.
 *
 * Real impl (deferred) wraps Anthropic Claude Sonnet 4.6 with
 * a vision system prompt that returns JSON in this shape.
 */

import { logger } from './logger.js';

export interface VisionIdentifyInput {
  imageRef: string;
  /** Optional textual hint ("customer says torsion spring snapped") */
  description?: string;
}

export interface VisionIdentifyOutput {
  make: string | null;
  model: string | null;
  /** Short phrase — "broken torsion spring", "off-track", etc. */
  failureMode: string | null;
  tags: string[];
  /** Raw model text; stored on the ai_messages transcript. */
  rawText: string;
  confidence: number;
}

export interface VisionClient {
  identify(input: VisionIdentifyInput): Promise<VisionIdentifyOutput>;
}

// ---------------------------------------------------------------------------
// Stub
// ---------------------------------------------------------------------------

export interface StubVisionFixture extends VisionIdentifyOutput {
  /** Lookup key. `identify` matches against `imageRef`. */
  key: string;
}

const BUILTIN_FIXTURES: StubVisionFixture[] = [
  {
    key: 'fixture:broken-torsion',
    make: 'Clopay',
    model: 'Classic Steel',
    failureMode: 'broken torsion spring',
    tags: ['broken-spring', 'torsion', 'clopay'],
    rawText:
      'The photo shows a Clopay Classic Steel door with a visibly snapped torsion spring on the shaft above the door.',
    confidence: 0.92,
  },
  {
    key: 'fixture:off-track',
    make: 'Wayne Dalton',
    model: '9100',
    failureMode: 'door off track',
    tags: ['off-track', 'wayne-dalton'],
    rawText: 'The bottom panel has separated from the vertical track on the left side.',
    confidence: 0.88,
  },
  {
    key: 'fixture:chain-opener-failed',
    make: 'LiftMaster',
    model: '1/2 HP chain drive',
    failureMode: 'opener chain slipped',
    tags: ['opener-failure', 'sku:OPN-CHAIN'],
    rawText:
      'The opener carriage is loose on the chain — likely a stripped gear or failed carriage.',
    confidence: 0.76,
  },
  {
    key: 'fixture:unknown',
    make: null,
    model: null,
    failureMode: null,
    tags: [],
    rawText: 'Unable to identify. The image is too dark or out of frame.',
    confidence: 0.2,
  },
];

/**
 * Stub looks up `imageRef` against the built-in + caller-provided
 * fixtures. Missing key falls back to the 'fixture:unknown' row so
 * tests exercising the low-confidence path don't need a custom
 * fixture.
 */
export function stubVisionClient(
  fixtures: StubVisionFixture[] = [],
): VisionClient {
  const all = [...BUILTIN_FIXTURES, ...fixtures];
  const byKey = new Map(all.map((f) => [f.key, f]));
  return {
    async identify({ imageRef }) {
      const fx = byKey.get(imageRef) ?? byKey.get('fixture:unknown')!;
      logger.debug({ imageRef, chose: fx.key }, 'vision (stub) identify');
      return {
        make: fx.make,
        model: fx.model,
        failureMode: fx.failureMode,
        tags: fx.tags,
        rawText: fx.rawText,
        confidence: fx.confidence,
      };
    },
  };
}

/**
 * Resolver. Real Anthropic vision wiring lands when the first
 * pilot uploads a real photo; phase 11 ships the interface +
 * fixture-driven stub so the rest of the pipeline is testable.
 */
export function resolveVisionClient(): VisionClient {
  if (!process.env['ANTHROPIC_API_KEY']) return stubVisionClient();
  // TODO: real Claude Sonnet 4.6 vision adapter. Tracked as
  //       phase_ai_tech_assistant AUDIT m2.
  return stubVisionClient();
}
