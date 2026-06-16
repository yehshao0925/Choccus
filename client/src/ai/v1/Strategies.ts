/**
 * Strategies — named, clearly-distinct bot AI archetypes built from the
 * `BotTuning` knobs (see BotConfig.ts). Three archetypes occupy different
 * corners of the original six-knob tuning space; a FOURTH (亂V/ChaosV) adds the
 * OPTIONAL 亂V chain knobs (vChainBombs/vChainChance/vChainFoeRange). Those
 * extra knobs are purely deterministic — they only change bomb-drop PRIORITY,
 * never the safety gate — so every archetype stays fully lockstep-safe, and any
 * archetype that omits them keeps the exact single-bomb behavior.
 *
 * Reaction is in ticks at the fixed 60 Hz timestep; the bomb fuse is 180 ticks.
 */
import type { BotTuning } from './BotConfig';

export const STRATEGIES: ReadonlyArray<{
  key: string;
  name: string;
  tuning: BotTuning;
}> = Object.freeze([
  // Aggressor — bombs at almost every opportunity with sharp reactions and a
  // short escape budget: relentless pressure, trades safety margin for tempo.
  Object.freeze({
    key: 'aggressor',
    name: 'Aggressor',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.03,
      replanIntervalTicks: 8,
      maxEscapeLen: 4,
      bombChance: 0.95,
      aggression: 1.8, // relentless pressure.
      recklessBombChance: 0,
    }),
  }),
  // Turtle/Survivor — rarely bombs and demands the longest escape route:
  // plays for outlasting opponents rather than killing them.
  Object.freeze({
    key: 'turtle',
    name: 'Turtle',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.04,
      replanIntervalTicks: 8,
      maxEscapeLen: 6,
      bombChance: 0.15,
      aggression: 0.3, // survival-first: minimal attack pull.
      recklessBombChance: 0,
    }),
  }),
  // Gambler/Reckless — sluggish reactions, frequent mistakes, and a real
  // chance of blind-bombing with no escape: high-variance boom-or-bust play.
  Object.freeze({
    key: 'gambler',
    name: 'Gambler',
    tuning: Object.freeze({
      reactionDelayTicks: 12,
      mistakeChance: 0.2,
      replanIntervalTicks: 18,
      maxEscapeLen: 4,
      bombChance: 0.9,
      aggression: 1.3, // high-variance aggression.
      recklessBombChance: 0.25,
    }),
  }),
  // 亂V/ChaosV — instead of single-bomb-and-retreat, lays a short V/zigzag
  // sequence of bombs (paced one per detonation so it never blows itself up)
  // when an enemy is close, walling off escape lanes to corner a fleeing foe.
  // Each chain bomb still passes the FULL escape validation single bombs use;
  // the chain only changes PRIORITY (bomb-again-now vs wander), never safety.
  Object.freeze({
    key: 'chaosv',
    name: '亂V/ChaosV',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.04,
      replanIntervalTicks: 8,
      maxEscapeLen: 5,
      bombChance: 0.9,
      aggression: 1.8, // relentless wall-off pressure.
      recklessBombChance: 0,
      vChainBombs: 3,
      vChainChance: 0.8,
      vChainFoeRange: 4,
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
 * no Math.random / Date.now — so it's safe for lockstep / online backfill.
 */
export function strategyForSlot(index: number): { tuning: BotTuning; name: string } {
  const n = STRATEGIES.length;
  // Normalize to a non-negative index even for negative inputs.
  const i = ((Math.trunc(index) % n) + n) % n;
  // STRATEGIES is a non-empty frozen literal, so this index is always in range.
  const s = STRATEGIES[i] as { key: string; name: string; tuning: BotTuning };
  return { tuning: s.tuning, name: s.name };
}
