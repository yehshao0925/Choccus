/**
 * Strategies — the v4 BACKBONE. Unlike v3 (a deliberately non-transitive ROSTER
 * kept frozen as the Bradley-Terry yardstick), a version under active evolution
 * develops ONE line at a time (see docs/ai-versions.md §七). v4's trunk is the
 * 控場流 / Zoner archetype — the strongest single strategy under the BT yardstick,
 * which is now the metric of record (we stop reading the v3-bench KILL-EDGE gate
 * / fair-duel lenses):
 *   - pirate Bradley-Terry rank-1 by a clear margin (Elo 1757–1762, above farmer
 *     1733–1740 and trapper 1726);
 *   - classic top of the near-tied {zoner ≈ trapper ≈ farmer} cluster (Elo
 *     1658–1671) — i.e. zoner out-rates farmer on BOTH maps;
 *   - zone control synergises with the sudden-death shrink: it holds a stand-off
 *     ring and herds the foe toward a corner while the shrink does the closing,
 *     so it wins by compression without diving into self-destruction (the side
 *     the shrink rewards).
 *
 * The tuning below is the v3 Zoner verbatim — v4 launches behaviour-identical to
 * v3:zoner, then evolves IN PLACE (first focus: the classic map, the weaker of
 * the two). The shared `BotTuning` knobs live in BotConfig.ts.
 *
 * Reaction is in ticks at the fixed 60 Hz timestep; the bomb fuse is 180 ticks.
 */
import type { BotTuning } from './BotConfig';

export const STRATEGIES: ReadonlyArray<{
  key: string;
  name: string;
  tuning: BotTuning;
}> = Object.freeze([
  // 控場流 Zoner — hold the centre and compress the foe from a STAND-OFF ring:
  // bomb to wall off lanes and herd the foe toward a corner / dead-end, but never
  // close inside `zoneStandoff`. The v4 backbone.
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
