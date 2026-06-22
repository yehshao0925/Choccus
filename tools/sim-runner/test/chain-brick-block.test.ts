/**
 * Chain detonation must NOT bulldoze through a brick (Explosion.ts).
 *
 * Bug: detonations process FIFO and the grid was mutated mid-propagation, so a
 * brick cleared by an earlier bomb turned EMPTY and a later co-detonating bomb's
 * arm flowed straight through it — burning a player the wall should have
 * shielded. A brick standing when the tick begins must block EVERY blast that
 * tick (each arm clears at most one brick).
 *
 * Layout (override map, all relevant tiles EMPTY except the one brick):
 *   bomb A at (1,3) fire 3 → RIGHT arm clears the brick at (3,3) and stops.
 *   bomb B at (3,1) fire 3 → DOWN arm hits the SAME brick at (3,3).
 *   player at (3,4) sits one tile BEHIND the brick, out of reach of every arm
 *   EXCEPT B's down-arm IF it leaks through the cleared brick.
 * Array order [A, B] + equal fuses ⇒ A clears (3,3) first, then B's arm meets it.
 */
import { describe, expect, it } from 'vitest';

import { MILLITILE } from '../../../shared/constants';
import { TileKind } from '../../../shared/types';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { NO_INPUT, type InputFrame } from '../../../client/src/sim/InputBuffer';
import { idx } from '../../../client/src/sim/Map';
import { clonePlayer } from '../../../client/src/sim/Player';
import { type SimState, createInitialState, tick } from '../../../client/src/sim/Sim';

const fp = makeFeelParams();
const IDLE: InputFrame = NO_INPUT;

function stage(): SimState {
  const base = createInitialState(0, fp, 2, { pvp: true, teams: [0, 1] });
  const map = new Uint8Array(base.map);
  const players = base.players.map(clonePlayer);
  // Clear the cross of tiles the two arms travel, then plant the single brick.
  for (const [x, y] of [[1, 3], [2, 3], [3, 3], [3, 1], [3, 2], [3, 4]] as const) {
    map[idx(x, y)] = TileKind.EMPTY;
  }
  map[idx(3, 3)] = TileKind.SOFT;
  // Victim one tile behind the brick (only B's leaked down-arm could reach it).
  players[0]!.posX = 3 * MILLITILE;
  players[0]!.posY = 4 * MILLITILE;
  // Other player parked far away, out of every blast.
  players[1]!.posX = 11 * MILLITILE;
  players[1]!.posY = 11 * MILLITILE;
  const bombs = [
    { ownerSlot: 0, tileX: 1, tileY: 3, fuseTicks: 1, fire: 3 },
    { ownerSlot: 1, tileX: 3, tileY: 1, fuseTicks: 1, fire: 3 },
  ];
  return { ...base, map, players, bombs };
}

const flameAt = (st: SimState, x: number, y: number): boolean =>
  st.explosions.some((c) => c.tileX === x && c.tileY === y);

describe('chain detonation: a tick-start brick blocks every blast', () => {
  it('a chained bomb does not flow through a brick a sibling cleared this tick', () => {
    let st = stage();
    st = tick(st, [IDLE, IDLE]); // both bombs detonate this tick

    expect(st.map[idx(3, 3)]).toBe(TileKind.EMPTY); // brick destroyed (once)
    expect(flameAt(st, 3, 2)).toBe(true); // B's arm reached the brick's near side
    expect(flameAt(st, 3, 4)).toBe(false); // ...but did NOT leak past it
    expect(st.players[0]!.trapped).toBe(false); // so the shielded player survives
  });
});
