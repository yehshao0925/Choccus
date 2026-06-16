/**
 * Unit tests for the read-only AI grid helpers (BFS + danger prediction).
 * These are pure-function tests over crafted SimState snapshots; they never
 * advance the sim and so cannot touch the golden hashes.
 */
import { describe, expect, it } from 'vitest';

import { FUSE_TICKS } from '../../../shared/constants';
import { Direction, TileKind } from '../../../shared/types';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { idx } from '../../../client/src/sim/Map';
import { createInitialState } from '../../../client/src/sim/Sim';
import {
  bfsFirstStep,
  findNearestSafe,
  hypotheticalBomb,
  isSafeTile,
  openPassable,
  predictDanger,
  tileDangerTicks,
} from '../../../client/src/ai/common/grid';

const fp = makeFeelParams();
const DIRS = [Direction.UP, Direction.DOWN, Direction.LEFT, Direction.RIGHT];

describe('bfsFirstStep', () => {
  it('returns NONE / dist 0 when the start already satisfies the goal', () => {
    const s = createInitialState(12345, fp, 1);
    const hit = bfsFirstStep(s, 1, 1, (x, y) => x === 1 && y === 1, openPassable(s));
    expect(hit).not.toBeNull();
    expect(hit!.firstDir).toBe(Direction.NONE);
    expect(hit!.dist).toBe(0);
    expect(hit!.target).toEqual([1, 1]);
  });

  it('finds a reachable goal with a valid first step', () => {
    const s = createInitialState(12345, fp, 1);
    const hit = bfsFirstStep(
      s,
      1,
      1,
      (x, y) => (x !== 1 || y !== 1) && openPassable(s)(x, y),
      openPassable(s),
    );
    expect(hit).not.toBeNull();
    expect(hit!.dist).toBeGreaterThan(0);
    expect(DIRS).toContain(hit!.firstDir);
  });

  it('returns null when no goal is reachable', () => {
    const s = createInitialState(12345, fp, 1);
    const hit = bfsFirstStep(s, 1, 1, () => false, openPassable(s));
    expect(hit).toBeNull();
  });
});

describe('predictDanger', () => {
  it('marks cross-flow tiles, stops at HARD bricks, and records fuse ticks', () => {
    const base = createInitialState(777, fp, 1);
    const map = new Uint8Array(base.map);
    const [cx, cy] = [7, 5];
    for (const [x, y] of [
      [7, 5],
      [6, 5],
      [5, 5],
      [8, 5],
      [9, 5],
      [7, 4],
      [7, 3],
      [7, 6],
      [7, 7],
    ] as const) {
      map[idx(x, y)] = TileKind.EMPTY;
    }
    // Right arm hits HARD at step 1 → (9,5) must stay clear.
    map[idx(8, 5)] = TileKind.HARD;

    const state = { ...base, map, bombs: [], explosions: [] };
    const danger = predictDanger(state, [hypotheticalBomb(cx, cy, 2, 0)]);

    expect(danger.until.has(idx(7, 5))).toBe(true);
    expect(danger.until.has(idx(6, 5))).toBe(true);
    expect(danger.until.has(idx(9, 5))).toBe(false);
    expect(danger.until.get(idx(7, 5))).toBe(FUSE_TICKS);

    expect(tileDangerTicks(danger, idx(7, 5))).toBe(FUSE_TICKS);
    expect(tileDangerTicks(danger, idx(9, 5))).toBeUndefined();
  });
});

describe('findNearestSafe', () => {
  it('escapes a bomb tile to a reachable safe tile', () => {
    const base = createInitialState(777, fp, 1);
    // Open a corridor so an escape exists past the fire-2 reach of the bomb.
    const map = new Uint8Array(base.map);
    map[idx(3, 1)] = TileKind.EMPTY;
    map[idx(4, 1)] = TileKind.EMPTY;
    map[idx(5, 1)] = TileKind.EMPTY;
    const state = {
      ...base,
      map,
      bombs: [hypotheticalBomb(1, 1, 2, 0)],
      explosions: [],
    };
    const danger = predictDanger(state);

    expect(isSafeTile(state, danger, 1, 1)).toBe(false);

    const safe = findNearestSafe(state, 1, 1, danger);
    expect(safe).not.toBeNull();
    expect(isSafeTile(state, danger, safe![0], safe![1])).toBe(true);
    expect(danger.until.has(idx(safe![0], safe![1]))).toBe(false);
  });
});

describe('determinism', () => {
  it('predictDanger is reproducible', () => {
    const base = createInitialState(777, fp, 1);
    const state = {
      ...base,
      bombs: [hypotheticalBomb(3, 3, 3, 0)],
      explosions: [],
    };
    const a = predictDanger(state);
    const b = predictDanger(state);
    expect([...a.until.entries()].sort()).toEqual([...b.until.entries()].sort());
  });

  it('bfsFirstStep is reproducible', () => {
    const s = createInitialState(12345, fp, 1);
    const goal = (x: number, y: number) =>
      (x !== 1 || y !== 1) && openPassable(s)(x, y);
    const hit1 = bfsFirstStep(s, 1, 1, goal, openPassable(s));
    const hit2 = bfsFirstStep(s, 1, 1, goal, openPassable(s));
    expect(hit1).toEqual(hit2);
  });
});
