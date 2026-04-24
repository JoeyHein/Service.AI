/**
 * Garage-door knowledge base seed (phase_ai_tech_assistant).
 *
 * 40 articles across brand profiles, common failures, and part
 * cross-references. Each article carries a tag set that phase-11
 * RAG queries over — the photoQuote pipeline extracts tags from
 * the vision output and passes them as `requireTags` so the
 * retriever can narrow before scoring.
 *
 * Tags are lowercase kebab-style and intentionally small so the
 * matching is robust:
 *   - brand tags: clopay, wayne-dalton, amarr, amarr-stormtite,
 *     chi, raynor
 *   - failure tags: broken-spring, torsion, extension, off-track,
 *     panel-damage, opener-failure, sensor-misalign, cable-snap,
 *     hinge-fail, roller-worn, weather-seal, jackshaft-opener
 *   - part tags: SKU-prefixed SKUs when the article maps to a
 *     specific pricebook entry (e.g. sku:SPR-TORSION,
 *     sku:OPN-CHAIN).
 */

import { Pool } from 'pg';
import { stubEmbeddingClient } from '../embedding.js';

interface KbSeed {
  source: string;
  title: string;
  body: string;
  tags: string[];
}

export const KB_SEED: KbSeed[] = [
  // Brand profiles -----------------------------------------------------------
  {
    source: 'brand-clopay-classic-steel',
    title: 'Clopay Classic Steel Collection overview',
    body: 'Clopay Classic Steel is a 2-layer steel door with polystyrene insulation. Common in residential US builds after 2005. Sections typically 21-gauge. Replacement spring families: TorqueMaster Plus (single torsion in tube) and TorqueMaster Original.',
    tags: ['clopay', 'brand', 'torsion', 'residential'],
  },
  {
    source: 'brand-clopay-gallery',
    title: 'Clopay Gallery Collection overview',
    body: 'Carriage-house-styled steel doors. Heavier than Classic Steel due to composite overlay; torsion spring upgrade often required on openers more than 10 years old. Common opener pair: LiftMaster 8500.',
    tags: ['clopay', 'brand', 'torsion', 'residential', 'carriage-house'],
  },
  {
    source: 'brand-wayne-dalton-9100',
    title: 'Wayne Dalton 9100 non-insulated',
    body: 'Older commercial single-layer steel door, often found in small warehouses. Uses standard extension springs. Panels prone to denting on forklift strikes. Replacement bottom brackets should be the tamper-resistant type.',
    tags: ['wayne-dalton', 'brand', 'extension', 'commercial'],
  },
  {
    source: 'brand-wayne-dalton-torquemaster',
    title: 'Wayne Dalton TorqueMaster spring system',
    body: 'Proprietary spring sealed inside a tube, visually similar to a regular shaft. Tech-only replacement tool required. Do not attempt to wind a TorqueMaster with standard winding bars.',
    tags: ['wayne-dalton', 'torsion', 'torquemaster', 'safety'],
  },
  {
    source: 'brand-amarr-stormtite',
    title: 'Amarr Stormtite high-wind garage door',
    body: 'Wind-rated door used in hurricane regions. Uses reinforced panels + additional center hinge. Spring replacement must use matched pair to maintain load rating.',
    tags: ['amarr', 'amarr-stormtite', 'brand', 'torsion', 'wind-rated'],
  },
  {
    source: 'brand-amarr-lincoln',
    title: 'Amarr Lincoln steel garage door',
    body: 'Mid-market residential 2-layer. Uses standard torsion. Panels replaceable individually — commonly requested after minor automobile bumps.',
    tags: ['amarr', 'brand', 'torsion', 'panel-damage', 'residential'],
  },
  {
    source: 'brand-chi-5300',
    title: 'C.H.I. 5300 residential steel',
    body: 'Insulated 2-layer steel door. Torsion spring standard; premium models ship with dual springs. Weatherstrip tends to fail after 5-7 years in UV-heavy regions.',
    tags: ['chi', 'brand', 'torsion', 'weather-seal', 'residential'],
  },
  {
    source: 'brand-raynor-aspen',
    title: 'Raynor Aspen insulated door',
    body: 'Polyurethane-insulated residential steel. Ships with enhanced torsion. Check spring cycle life stamp on shaft — 10k or 20k cycle family.',
    tags: ['raynor', 'brand', 'torsion', 'residential'],
  },
  // Common failures ----------------------------------------------------------
  {
    source: 'fail-broken-torsion',
    title: 'Diagnosing a broken torsion spring',
    body: 'A broken torsion spring is usually visually obvious — a gap of 1-3 inches in the coil on the shaft. Door will be extremely heavy to lift and the opener will strain or fail to lift. Always replace in pairs if the door has two springs.',
    tags: ['broken-spring', 'torsion', 'diagnostic', 'sku:SPR-TORSION', 'sku:SPR-TORSION-PAIR'],
  },
  {
    source: 'fail-broken-extension',
    title: 'Diagnosing a broken extension spring',
    body: 'Extension springs snap at the end hook most often. Inspect for visible gaps and safety cables. Replace both sides simultaneously even if only one is visibly broken.',
    tags: ['broken-spring', 'extension', 'diagnostic', 'sku:SPR-EXT', 'sku:SPR-EXT-PAIR'],
  },
  {
    source: 'fail-off-track',
    title: 'Door off the track',
    body: 'Common causes: vehicle impact, broken roller, loose track bolts. Partial off-track can be reset in <30 minutes; full off-track often requires panel replacement. Never run the opener until the door is re-seated.',
    tags: ['off-track', 'diagnostic', 'sku:REP-OFFTRACK'],
  },
  {
    source: 'fail-opener-dead',
    title: 'Opener does not respond to remote or wall button',
    body: 'Check: 1) power at the outlet, 2) lockout switch on wall console, 3) logic board LED. If logic board LED is off despite power, the board is likely failed. Most common in 15+ year old units.',
    tags: ['opener-failure', 'diagnostic'],
  },
  {
    source: 'fail-opener-runs-no-move',
    title: 'Opener runs but door does not move',
    body: 'Gear stripping on chain-drive openers (LiftMaster 1/2hp, Genie Pro Series). Sometimes presents as grinding sound. Gear kit replacement is faster than unit replacement on openers <10 years old.',
    tags: ['opener-failure', 'diagnostic', 'sku:OPN-CHAIN'],
  },
  {
    source: 'fail-sensor-misalign',
    title: 'Safety sensors blinking / flashing LED',
    body: 'Sensors must be aligned within ~1° of each other. Check the indicator LED on the receiving sensor. Common fix: realign by loosening wing nut, sighting down the beam path, and retightening. Lens wipe if blocked.',
    tags: ['sensor-misalign', 'opener-failure', 'diagnostic', 'sku:REP-SENSORALIGN'],
  },
  {
    source: 'fail-cable-snap',
    title: 'Broken lift cable',
    body: 'A broken cable on one side lets the door tilt. Treat as emergency — do not cycle the opener. Cable replacement requires unwinding the torsion spring or locking the shaft. Replace in pairs.',
    tags: ['cable-snap', 'torsion', 'safety', 'sku:REP-CABLE'],
  },
  {
    source: 'fail-hinge',
    title: 'Broken or bent hinges',
    body: 'Most common between sections 1-2 and 2-3 due to lateral flex during off-track events. Replace any bent hinge even if not broken — flex propagates.',
    tags: ['hinge-fail', 'diagnostic', 'sku:REP-HINGE'],
  },
  {
    source: 'fail-roller-worn',
    title: 'Worn rollers',
    body: 'Nylon rollers have a 7-10 year life. Symptoms: noisy operation, binding in the track. Steel rollers last longer but need periodic lubrication. Replace in full set of 10.',
    tags: ['roller-worn', 'diagnostic', 'sku:REP-ROLLER'],
  },
  {
    source: 'fail-weather-seal',
    title: 'Worn bottom weather seal',
    body: 'Bottom seal typically lasts 5-7 years depending on UV exposure and freeze-thaw cycles. Symptom: visible gap between door and floor when fully closed, draft, insects.',
    tags: ['weather-seal', 'diagnostic', 'sku:REP-BOTTOMSEAL'],
  },
  {
    source: 'fail-jackshaft',
    title: 'Jackshaft opener diagnosis',
    body: 'Wall-mounted side-drive openers (LiftMaster 8500, Sommer Direct Drive). No overhead rail. Common failures: motor coupler, encoder sensor, wall mount separation.',
    tags: ['opener-failure', 'jackshaft-opener', 'diagnostic', 'sku:OPN-JACKSHAFT'],
  },
  {
    source: 'fail-panel-damage',
    title: 'Panel damage assessment',
    body: 'Individual sections can be replaced on most modern doors (Clopay, Amarr, C.H.I.). Older or discontinued models may require full door replacement. Always verify part number + color match before quoting.',
    tags: ['panel-damage', 'diagnostic', 'sku:REP-PANEL'],
  },
  // Part cross-references ---------------------------------------------------
  {
    source: 'part-torsion-crossref',
    title: 'Torsion spring cross-reference table',
    body: 'Wire diameter + inside diameter + length determines the spring. Common residential: 0.225 wire, 2-inch ID. Heavy-duty: 0.250 wire. Always match IPPT (inches per pound turn) to the door weight chart.',
    tags: ['torsion', 'part-crossref', 'sku:SPR-TORSION', 'sku:SPR-HD'],
  },
  {
    source: 'part-extension-crossref',
    title: 'Extension spring cross-reference',
    body: 'Extension springs are color-coded by lift weight: yellow=80lb, red=100lb, green=120lb, tan=140lb, orange=160lb, gold=180lb. Always match the door lift weight, not the old spring color (can be faded).',
    tags: ['extension', 'part-crossref', 'sku:SPR-EXT', 'sku:SPR-EXT-PAIR'],
  },
  {
    source: 'part-roller-types',
    title: 'Roller types and ratings',
    body: '10-ball nylon with 7-inch stems is the residential default. Heavy-duty steel with 13-ball bearings for commercial or 2-car wooden doors. Nylon is quieter but wears faster.',
    tags: ['roller-worn', 'part-crossref', 'sku:REP-ROLLER'],
  },
  {
    source: 'part-opener-chain-vs-belt',
    title: 'Chain vs belt opener selection',
    body: 'Belt: quieter, 30% more expensive, better for bedrooms adjacent to garage. Chain: more robust for heavy commercial doors, longer service life under cold-weather cycling. Match HP to door weight: 1/2 hp for single 2-layer, 3/4 hp for 2-car wood.',
    tags: ['opener-failure', 'part-crossref', 'sku:OPN-CHAIN', 'sku:OPN-BELT'],
  },
  {
    source: 'part-smart-openers',
    title: 'Smart opener (myQ, HomeLink) compatibility',
    body: 'myQ-enabled openers report status to a phone app. Older units (pre-2014) lack security 2.0 and cannot pair with modern remotes — upgrade to a smart belt drive.',
    tags: ['opener-failure', 'part-crossref', 'sku:OPN-SMART-BELT'],
  },
  {
    source: 'part-remote-keypad',
    title: 'Remote and wireless keypad programming',
    body: 'Three-button remote pairs via the learn button on the opener logic board. Rolling-code remotes from post-2011 openers are not backward-compatible with pre-2011 openers.',
    tags: ['opener-failure', 'part-crossref', 'sku:OPN-REMOTE', 'sku:OPN-KEYPAD'],
  },
  {
    source: 'part-bottom-bracket',
    title: 'Bottom bracket replacement',
    body: 'Tamper-resistant bottom brackets are required on residential doors per modern safety codes. Original brackets under tension from the lift cables — never remove without securing the cable or shaft.',
    tags: ['cable-snap', 'part-crossref'],
  },
  {
    source: 'part-track-alignment',
    title: 'Track alignment basics',
    body: 'Horizontal tracks should be level ±1/16 inch over their length. Vertical tracks plumb. Track flare at the top (1.5 inches outward) allows roller disengagement during full-open.',
    tags: ['off-track', 'part-crossref', 'sku:REP-TRACK'],
  },
  // Safety + procedure ------------------------------------------------------
  {
    source: 'safety-spring-winding',
    title: 'Torsion spring winding safety',
    body: 'Always use a matched pair of winding bars — never screwdrivers. Face away from the spring during winding. One revolution = one full turn = typically 4 inches of door travel. Confirm torque balance by opening the door to 3 feet by hand.',
    tags: ['torsion', 'broken-spring', 'safety'],
  },
  {
    source: 'safety-off-track',
    title: 'Safe off-track recovery',
    body: 'Never run the opener with the door partially off-track. Clamp the track above the roller, disengage the opener, reseat by hand. If panels are bent, treat as panel replacement instead of a field repair.',
    tags: ['off-track', 'panel-damage', 'safety'],
  },
  {
    source: 'safety-opener-lockout',
    title: 'Opener lockout before service',
    body: 'Unplug the opener (not just the wall switch) before any spring, cable, or panel work. Some units retain capacitor charge — wait 60 seconds before touching the logic board.',
    tags: ['opener-failure', 'safety'],
  },
  // Operations / sales ------------------------------------------------------
  {
    source: 'ops-quote-single-vs-pair',
    title: 'Quoting spring pair vs single',
    body: 'Best practice on dual-spring doors: quote both springs even if only one is broken. Matched cycle life; customer pays one service trip. Single-spring quotes must disclose the risk of the second spring failing within 6-18 months.',
    tags: ['broken-spring', 'torsion', 'quoting', 'sku:SPR-TORSION-PAIR'],
  },
  {
    source: 'ops-quote-tune-up',
    title: 'Tune-up service scope',
    body: 'Standard tune-up: lubricate rollers, hinges, and springs with white lithium grease; tighten all bolts; inspect cables and sensors; align sensor eyes. No parts included.',
    tags: ['roller-worn', 'quoting', 'sku:REP-LUBRICATE'],
  },
  {
    source: 'ops-install-haul',
    title: 'Old door haul-away',
    body: 'Old door haul-away is a separate line item. Most landfills require the spring be disconnected before acceptance.',
    tags: ['quoting', 'sku:INST-REMOVE'],
  },
  {
    source: 'ops-aluminum-panorama',
    title: 'Aluminum / full-view panorama doors',
    body: 'Aluminum-frame glass-panel doors (common in showrooms and modern residential) use heavier torsion (HD family) and specialized hinges. Full-view doors require glass-compatible hinges.',
    tags: ['amarr', 'clopay', 'wayne-dalton', 'quoting', 'sku:INST-ALUM'],
  },
  // Diagnostic decision trees ----------------------------------------------
  {
    source: 'tree-door-wont-open',
    title: 'Decision tree: door won\'t open',
    body: '1) Check visible spring gap → broken spring. 2) Opener LED on? → if no, check power. 3) Opener LED on but no motion → gear or motor failure. 4) Motor runs but door stays → gear stripping.',
    tags: ['broken-spring', 'opener-failure', 'diagnostic'],
  },
  {
    source: 'tree-door-reverses',
    title: 'Decision tree: door reverses on close',
    body: '1) Check safety sensors for blinking LED → realign. 2) Force setting too low → increase by 1/4 turn and retest. 3) Worn rollers causing binding in track → replace rollers.',
    tags: ['sensor-misalign', 'opener-failure', 'roller-worn', 'diagnostic'],
  },
  {
    source: 'tree-door-noisy',
    title: 'Decision tree: door is noisy',
    body: '1) Worn rollers → loudest single contributor, replace first. 2) Loose hardware → tighten all visible bolts. 3) Dry spring → lubricate with spring-specific silicone spray.',
    tags: ['roller-worn', 'hinge-fail', 'diagnostic', 'sku:REP-ROLLER'],
  },
  {
    source: 'tree-door-sag-middle',
    title: 'Decision tree: door sags in the middle',
    body: '1) Bent center strut → replace. 2) Worn hinges between sections 2-3 → replace. 3) Rare: bent shaft after vehicle impact.',
    tags: ['hinge-fail', 'panel-damage', 'diagnostic', 'sku:REP-HINGE'],
  },
  {
    source: 'tree-wind-rated',
    title: 'Decision tree: wind-rated door failure after storm',
    body: 'Wind-rated doors (Amarr Stormtite, etc.) must have intact center posts + all hinges. Any visible deflection requires engineering inspection before returning to service.',
    tags: ['amarr-stormtite', 'wind-rated', 'panel-damage', 'diagnostic'],
  },
];

/**
 * Idempotent seed helper. Called from runSeed after the base
 * franchisor rows exist. Inserts with `ON CONFLICT (source) DO
 * NOTHING` so re-running is safe.
 */
export async function runKbSeed(
  pool: InstanceType<typeof Pool>,
  franchisorId: string,
): Promise<void> {
  for (const doc of KB_SEED) {
    const embedding = await stubEmbeddingClient.embed(doc.tags.join(' '));
    await pool.query(
      `INSERT INTO kb_docs (franchisor_id, title, body, source, embedding, tags)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (source) DO NOTHING`,
      [
        franchisorId,
        doc.title,
        doc.body,
        doc.source,
        JSON.stringify(embedding),
        JSON.stringify(doc.tags),
      ],
    );
  }
}
