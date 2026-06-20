/**
 * Strategies — the v3 ROSTER: a deliberately NON-TRANSITIVE set of archetypes so
 * the 1v1 win-rate MATRIX (not a single Bradley-Terry scalar) reveals the
 * rock-paper-scissors structure. Each archetype is built from the shared
 * `BotTuning` knobs (see BotConfig.ts) plus one behaviour-axis flag, so they
 * occupy genuinely different corners of the strategy space while all staying
 * fully deterministic / lockstep-safe.
 *
 * CORE 3-CYCLE (intransitive on purpose): Hunter > Farmer > Zoner > Hunter.
 *   - 獵殺流 Hunter  — always closes on the foe, bombs in range, no farming,
 *                      trades safety for tempo. Kills a greedy Farmer early;
 *                      loses to Zoner/Trapper who wall off its attack lanes.
 *   - 養成流 Farmer  — farms bricks/items first, avoids combat early, snowballs
 *                      firepower then wins on stats. Out-ranges Zoner/Runner;
 *                      loses to Hunter (stolen in the weak early window).
 *   - 控場流 Zoner   — cuts the map, holds centre, compresses the foe from a
 *                      stand-off ring toward a corner, never closes in. Seals
 *                      Hunter's lanes / Runner's escape; loses to Farmer's range.
 * EDGE SPECIALISTS (each guards one independent weakness axis):
 *   - 逃跑流 Runner  — pure survival, walks to the farthest safe tile, barely
 *                      bombs. Exhausts a reckless Hunter; loses to Zoner/Farmer.
 *   - 陷阱流 Trapper — never fights head-on, lures the foe into corridors /
 *                      dead-ends with V/zig-zag chains then seals. Eats
 *                      predictable movers; loses to Reactive / Noise.
 *   - 反應流 Reactive— mirrors/counters the foe's last action, never leads the
 *                      tempo. Beats deterministic strategies; loses to Noise.
 * OUT-OF-POOL JUDGE (strength floor / anti-overfit, not for the gate):
 *   - 隨機擾動 Noise — weighted-random legal moves, only "don't actively suicide"
 *                      rationality. If a build LOSES to it the build is broken;
 *                      if the strongest build only barely beats it, its strength
 *                      is overfit hot air.
 *
 * Reaction is in ticks at the fixed 60 Hz timestep; the bomb fuse is 180 ticks.
 */
import type { BotTuning } from './BotConfig';

export const STRATEGIES: ReadonlyArray<{
  key: string;
  name: string;
  tuning: BotTuning;
}> = Object.freeze([
  // 獵殺流 Hunter — always approach the foe on the shortest path, bomb the moment
  // it is in range, accept high risk; never farms or detours for items. Short
  // escape budget = pure tempo. (Merged from the old Aggressor + kill doctrine.)
  Object.freeze({
    key: 'hunter',
    name: '獵殺流/Hunter',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.03,
      replanIntervalTicks: 8,
      maxEscapeLen: 4,
      bombChance: 0.95,
      aggression: 2.0,
      recklessBombChance: 0,
      combatRangeTiles: 9, // engage from far — it hunts, it doesn't wait.
      pureHunt: true,
    }),
  }),
  // 養成流 Farmer — open by clearing bricks and grabbing fire/cannon/speed, avoid
  // combat hard until developed, then let the stat lead decide. Loses its early
  // window to Hunter; rolls Zoner/Runner late.
  Object.freeze({
    key: 'farmer',
    name: '養成流/Farmer',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.03,
      replanIntervalTicks: 8,
      maxEscapeLen: 6, // longest escape budget → safest farming.
      bombChance: 0.98, // farm at nearly every opportunity.
      aggression: 0.3, // minimal: never hunt while still developing.
      recklessBombChance: 0,
      combatRangeTiles: 4, // only engage at point-blank, else keep farming.
    }),
  }),
  // 控場流 Zoner — hold the centre and compress the foe from a STAND-OFF ring:
  // bomb to wall off lanes and herd the foe toward a corner / dead-end, but never
  // close inside `zoneStandoff`. Seals Hunter's attack and Runner's escape; gets
  // out-ranged by a developed Farmer.
  Object.freeze({
    key: 'zoner',
    name: '控場流/Zoner',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.03,
      replanIntervalTicks: 8,
      maxEscapeLen: 5,
      bombChance: 0.85,
      aggression: 1.4,
      recklessBombChance: 0,
      combatRangeTiles: 7,
      zoneStandoff: 4, // hold the ring ~4 tiles out; compress, don't dive.
    }),
  }),
  // 逃跑流 Runner — pure survival: always walk to the farthest safe tile from the
  // foe, almost never drop an effective bomb. Exhausts a reckless Hunter into
  // self-destruction; can't make a kill itself, so it loses to Zoner/Farmer.
  Object.freeze({
    key: 'runner',
    name: '逃跑流/Runner',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.03,
      replanIntervalTicks: 8,
      maxEscapeLen: 6,
      bombChance: 0.1, // barely bombs.
      aggression: 0.1, // never hunts.
      recklessBombChance: 0,
      combatRangeTiles: 3,
      fleeFoe: true,
    }),
  }),
  // 陷阱流 Trapper — never fights head-on; lays V/zig-zag chains to lure the foe
  // into a corridor / dead-end then seals the mouth. Feeds on predictable movers
  // (Hunter, Runner); a Reactive or Noise foe it can't bait. (Merged from ChaosV.)
  Object.freeze({
    key: 'trapper',
    name: '陷阱流/Trapper',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.04,
      replanIntervalTicks: 8,
      maxEscapeLen: 5,
      bombChance: 0.9,
      aggression: 1.6,
      recklessBombChance: 0,
      vChainBombs: 3,
      vChainChance: 0.85,
      vChainFoeRange: 4,
      combatRangeTiles: 5,
    }),
  }),
  // 反應流 Reactive — pure counter-puncher: shadow-mirror the foe's last move and
  // pounce (seal its escape) the instant it commits a bomb; never leads the
  // tempo. Punishes deterministic strategies that telegraph; a random foe (Noise)
  // gives it nothing to mirror.
  Object.freeze({
    key: 'reactive',
    name: '反應流/Reactive',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.03,
      replanIntervalTicks: 8,
      maxEscapeLen: 5,
      bombChance: 0.7,
      aggression: 1.0,
      recklessBombChance: 0,
      combatRangeTiles: 5,
      mirror: true,
    }),
  }),
  // 隨機擾動 Noise — OUT-OF-POOL judge (not a gate target): weighted-random legal
  // moves with only "don't step into fire / don't bomb without an escape"
  // rationality. The strength FLOOR — losing to it means a build is broken;
  // barely beating it means a build's strength is overfit.
  Object.freeze({
    key: 'noise',
    name: '隨機擾動/Noise',
    tuning: Object.freeze({
      reactionDelayTicks: 6,
      mistakeChance: 0.5,
      replanIntervalTicks: 6,
      maxEscapeLen: 4,
      bombChance: 0.3,
      aggression: 0.5,
      recklessBombChance: 0,
      noise: true,
    }),
  }),
]);

/**
 * Resolve a named strategy by key (case-insensitive, whitespace-trimmed) to its
 * tuning + display name. Returns undefined for any key that isn't a known
 * archetype (callers fall back to difficulty tuning).
 */
export function resolveStrategy(
  key: string,
): { tuning: BotTuning; name: string } | undefined {
  const k = key.toLowerCase().trim();
  const s = STRATEGIES.find((e) => e.key === k);
  return s === undefined ? undefined : { tuning: s.tuning, name: s.name };
}

/**
 * Deterministically pick a strategy for a given index (mix mode): cycles
 * through STRATEGIES by `index mod STRATEGIES.length`. Fully deterministic —
 * no nondeterministic randomness / wall-clock — safe for lockstep / backfill.
 */
export function strategyForSlot(index: number): { tuning: BotTuning; name: string } {
  const n = STRATEGIES.length;
  // Normalize to a non-negative index even for negative inputs.
  const i = ((Math.trunc(index) % n) + n) % n;
  // STRATEGIES is a non-empty frozen literal, so this index is always in range.
  const s = STRATEGIES[i] as { key: string; name: string; tuning: BotTuning };
  return { tuning: s.tuning, name: s.name };
}
