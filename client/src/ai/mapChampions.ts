import type { MapKind } from '../sim/Map';
/** Per-map matrix-bench rank-1 (the "champion") used as the DEFAULT solo bot.
 *  Update if a future tuning pass changes the champion (see tools/sim-runner
 *  matrix-bench + docs/ai-versions.md). */
export const MAP_CHAMPION: Readonly<Record<MapKind, { version: number; archetype: string }>> =
  Object.freeze({
    classic: { version: 3, archetype: 'trapper' },
    pirate:  { version: 3, archetype: 'trapper' },
  });
export function championFor(map: MapKind): { version: number; archetype: string } {
  return MAP_CHAMPION[map];
}
