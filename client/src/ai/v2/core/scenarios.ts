/**
 * Pessimistic opponent scenarios for the v2 forward-search bot.
 *
 * The forward search treats the map / bombs / explosion timeline as STATIC over
 * its horizon (buildDangerMap already encodes the full future flame schedule).
 * To make the bot robust against what the OPPONENTS might do, we build a small
 * FIXED set of worst-case danger maps ("scenarios") layering hypothetical enemy
 * / lane-block bombs on top of the live state, and have the search take the MIN
 * survivability across them (maximin) while scoring reward against the
 * optimistic baseline (scenario 0).
 *
 * PURE / prng-free: never reads or advances SimState.prng, never calls tick().
 * All iteration is in fixed order (state.players array order, DIRECTION_ORDER).
 */
import type { SimState } from '../../../sim/Sim';
import type { BombState } from '../../../sim/Bomb';
import { DIRECTION_ORDER } from '../../../sim/InputBuffer';
import { idx, inBounds } from '../../../sim/Map';
import { dirDX, dirDY, tileOf } from '../../../sim/Player';
import { FUSE_TICKS } from '../../../../../shared/constants';
import { bfsReachable, hypotheticalBomb, openPassable } from '../../common/grid';
import { type IntervalDanger, buildDangerMap } from '../../common/dangerMap';

/** Cap on how many nearest enemies contribute hypothetical pressure bombs. */
export const MAX_SCENARIO_ENEMIES = 2;

/** Fixed number of scenarios returned by buildScenarios. */
export const SCENARIO_COUNT = 3;

/**
 * Collect up to MAX_SCENARIO_ENEMIES nearest ATTACKABLE enemies (different team,
 * alive, not trapped, different slot) within `foeReachTiles` BFS hops of the bot
 * AND with cannon > 0. Sorted by BFS hop distance; ties broken by player array
 * order (deterministic). Returns their hypothetical bombs.
 */
function enemyPressureBombs(
  state: SimState,
  myX: number,
  myY: number,
  mySlot: number,
  myTeam: number,
  foeReachTiles: number,
): BombState[] {
  const reach = bfsReachable(state, myX, myY, openPassable(state));
  // Candidate enemies with their hop distance, in player array order.
  const cands: Array<{ order: number; dist: number; bomb: BombState }> = [];
  let order = 0;
  for (const p of state.players) {
    const myOrder = order;
    order += 1;
    if (p.slot === mySlot || !p.alive || p.trapped) continue;
    if (p.team === myTeam) continue;
    if (p.cannon <= 0) continue;
    const ex = tileOf(p.posX);
    const ey = tileOf(p.posY);
    const info = reach.get(idx(ex, ey));
    if (info === undefined) continue;
    if (info.dist > foeReachTiles) continue;
    cands.push({
      order: myOrder,
      dist: info.dist,
      bomb: hypotheticalBomb(ex, ey, p.fire, p.slot),
    });
  }
  // Sort by hop distance asc; tie-break by player array order asc. Stable +
  // deterministic; no RNG.
  cands.sort((a, b) => (a.dist !== b.dist ? a.dist - b.dist : a.order - b.order));
  return cands.slice(0, MAX_SCENARIO_ENEMIES).map((c) => c.bomb);
}

/**
 * Build the FIXED-order scenario danger maps:
 *   [0] Baseline — buildDangerMap(state).
 *   [1] Opponent pressure — nearest enemies' hypothetical bombs layered in.
 *   [2] Lane-block — bombs injected on open cardinal neighbours leading toward a
 *       reachable safe tile, modelling an opponent walling off our escape lanes.
 * Scenarios [1]/[2] fall back to the baseline when there is nothing to inject.
 */
export function buildScenarios(
  state: SimState,
  myX: number,
  myY: number,
  mySlot: number,
  myTeam: number,
  foeReachTiles: number,
): IntervalDanger[] {
  const baseline = buildDangerMap(state);

  // [1] Opponent pressure.
  const enemyHyps = enemyPressureBombs(
    state,
    myX,
    myY,
    mySlot,
    myTeam,
    foeReachTiles,
  );
  const pressure =
    enemyHyps.length === 0 ? baseline : buildDangerMap(state, enemyHyps);

  // [2] Lane-block: for each open cardinal neighbour (DIRECTION_ORDER) that
  // leads toward a reachable, currently-safe tile, inject a hypothetical bomb on
  // that neighbour (fire 2, stable slot = mySlot — a pure pressure source). The
  // fuse defaults to FUSE_TICKS so it detonates like a freshly-dropped bomb.
  const base = openPassable(state);
  const reach = bfsReachable(state, myX, myY, base);
  const laneHyps: BombState[] = [];
  for (const d of DIRECTION_ORDER) {
    const nx = myX + dirDX(d);
    const ny = myY + dirDY(d);
    if (!inBounds(nx, ny) || !base(nx, ny)) continue;
    const info = reach.get(idx(nx, ny));
    if (info === undefined) continue;
    // "Leads toward a reachable safe tile": this neighbour is reachable and the
    // bot has somewhere non-lethal to go through it. The neighbour itself must
    // currently be non-lethal in the baseline (otherwise it's no lane).
    if (baseline.earliestLethal(idx(nx, ny)) !== undefined) continue;
    const hyp = hypotheticalBomb(nx, ny, 2, mySlot);
    hyp.fuseTicks = FUSE_TICKS;
    laneHyps.push(hyp);
  }
  const laneBlock =
    laneHyps.length === 0 ? baseline : buildDangerMap(state, laneHyps);

  return [baseline, pressure, laneBlock];
}
