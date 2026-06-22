import type { MapKind } from '../sim/Map';
/** Per-map champion = the strongest bot on that map, used as the DEFAULT solo
 *  bot. v5:zoner = the v4 Zoner backbone plus a DEFENSIVE escape-redundancy axis
 *  (anti-entrapment penalty + robust refuge selection) countering follow-up
 *  "seal" bombs.
 *
 *  - classic: v5:zoner, still clearly #1 (beats v4 55.6% head-to-head; v5-probe).
 *  - pirate:  v4:zoner. The 2026-06-22 chain-leak fix (Explosion.ts: a blast no
 *    longer flows through a brick a co-detonating bomb cleared the same tick)
 *    rebaselined the brick-dense pirate map. v5's pirate edge over v4 regressed
 *    from 55.0% to 47.9% (v5-probe, 240 duels) — a near-tie with v4 marginally
 *    ahead — so the eval-strongest main-trunk strategy on pirate is now v4:zoner.
 *    (v5 still beats v3:trapper there, 54.4%.) The shared Bradley-Terry ladder
 *    was seeded under the pre-fix sim and is stale for pirate.
 *
 *  See tools/sim-runner v5-probe + docs/ai-versions.md §九. Update if a future
 *  tuning pass (or a fresh bt-seed under the fixed sim) changes the top row. */
export const MAP_CHAMPION: Readonly<Record<MapKind, { version: number; archetype: string }>> =
  Object.freeze({
    classic: { version: 5, archetype: 'zoner' },
    pirate:  { version: 4, archetype: 'zoner' },
  });
export function championFor(map: MapKind): { version: number; archetype: string } {
  return MAP_CHAMPION[map];
}
