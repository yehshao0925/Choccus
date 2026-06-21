/**
 * Strategies — the v4 BACKBONE. Unlike v3 (a deliberately non-transitive ROSTER
 * kept frozen as the Bradley-Terry yardstick), a version under active evolution
 * develops ONE line at a time (see docs/ai-versions.md §七). v4's trunk is the
 * 養成流 / Farmer archetype, chosen to shore up the WEAKER map:
 *   - classic is the lower-scoring map on every live metric (v3-bench KILL-EDGE
 *     69.2% vs pirate 81.7%; fair-duel ~70% vs ~80%) — the closed-map farming /
 *     tiebreak race that has always been the hard one;
 *   - Farmer is the classic gate CHAMPION (v3-bench best 69.2%, mapChampions
 *     classic→farmer) and the strongest developer, exactly the side the
 *     sudden-death shrink rewards ("發育＋控場才贏"; over-aggression self-destructs
 *     on the shrinking arena);
 *   - it snowballs firepower then converts the stat lead in the forced-contact
 *     endgame the shrink creates — the largest surface to evolve v4's early
 *     window (its only documented weakness, the Hunter-stolen opening).
 *
 * The tuning below is the v3 Farmer verbatim — v4 launches behaviour-identical
 * to v3:farmer, then evolves IN PLACE. The shared `BotTuning` knobs live in
 * BotConfig.ts.
 *
 * Reaction is in ticks at the fixed 60 Hz timestep; the bomb fuse is 180 ticks.
 */
import type { BotTuning } from './BotConfig';

export const STRATEGIES: ReadonlyArray<{
  key: string;
  name: string;
  tuning: BotTuning;
}> = Object.freeze([
  // 養成流 Farmer — open by clearing bricks and grabbing fire/cannon/speed, avoid
  // combat hard until developed, then let the stat lead decide. The v4 backbone.
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
 * v4 has a single backbone, so every index resolves to the Trapper trunk.
 */
export function strategyForSlot(index: number): { tuning: BotTuning; name: string } {
  const n = STRATEGIES.length;
  // Normalize to a non-negative index even for negative inputs.
  const i = ((Math.trunc(index) % n) + n) % n;
  // STRATEGIES is a non-empty frozen literal, so this index is always in range.
  const s = STRATEGIES[i] as { key: string; name: string; tuning: BotTuning };
  return { tuning: s.tuning, name: s.name };
}
