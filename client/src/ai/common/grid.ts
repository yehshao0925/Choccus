/**
 * Real-time AI grid helpers: BFS pathfinding + blast-danger prediction.
 *
 * This module is a READ-ONLY, deterministic view over SimState. It NEVER
 * mutates SimState (or its arrays / typed-array map) and NEVER reads or
 * advances `state.prng` — so it cannot perturb the lockstep golden hashes.
 * No randomness, no wall-clock, no floating-point distance math: BFS uses
 * Manhattan-style integer steps and a fixed neighbor order.
 *
 * BFS determinism contract: neighbor expansion always follows DIRECTION_ORDER
 * (UP, DOWN, LEFT, RIGHT — see InputBuffer.ts), so the first-step / target
 * choice is reproducible.
 *
 * Danger prediction is intentionally CONSERVATIVE: each bomb's cross-flow is
 * traced from its center using the same arm rules as Explosion.ts, except that
 * when an arm passes over a tile that already holds another bomb we keep
 * flowing outward (the real sim would chain and stop there) — over-marking is
 * safer for an AI deciding where NOT to stand.
 */
import type { SimState } from '../../sim/Sim';
import { type BombState, bombAt } from '../../sim/Bomb';
import { DIRECTION_ORDER } from '../../sim/InputBuffer';
import { idx, inBounds } from '../../sim/Map';
import { dirDX, dirDY, isOpen } from '../../sim/Player';
import { explosionAt } from '../../sim/Explosion';
import { FUSE_TICKS, MAP_COLS } from '../../../../shared/constants';
import { Direction, TileKind } from '../../../../shared/types';

/** Tile-walkability predicate for BFS expansion (the start tile is exempt). */
export type Passable = (x: number, y: number) => boolean;

export interface BfsHit {
  /** Direction bit of the first step; Direction.NONE if start already a goal. */
  firstDir: number;
  /** Steps to the target (path tiles − 1). */
  dist: number;
  target: readonly [number, number];
}

/**
 * BFS from (fromX, fromY) to the nearest tile satisfying `isGoal`, expanding
 * neighbors in DIRECTION_ORDER. The START tile is EXEMPT from `passable`.
 * Returns null if no goal is reachable. If the start itself satisfies the goal
 * the hit is { firstDir: Direction.NONE, dist: 0, target: start }.
 */
export function bfsFirstStep(
  state: SimState,
  fromX: number,
  fromY: number,
  isGoal: (x: number, y: number) => boolean,
  passable: Passable,
): BfsHit | null {
  const startIdx = idx(fromX, fromY);
  const prev = new Map<number, number>();
  prev.set(startIdx, -1);

  const queue: number[] = [startIdx];
  let cursor = 0;

  while (cursor < queue.length) {
    const cur = queue[cursor];
    cursor += 1;
    if (cur === undefined) continue;
    const cx = cur % MAP_COLS;
    const cy = Math.floor(cur / MAP_COLS);

    if (isGoal(cx, cy)) {
      return reconstruct(prev, startIdx, cur);
    }

    for (const d of DIRECTION_ORDER) {
      const nx = cx + dirDX(d);
      const ny = cy + dirDY(d);
      if (!inBounds(nx, ny)) continue;
      const nIdx = idx(nx, ny);
      if (prev.has(nIdx)) continue;
      if (!passable(nx, ny)) continue;
      prev.set(nIdx, cur);
      queue.push(nIdx);
    }
  }
  return null;
}

/** Walk `prev` back from goal to start, building the [x,y] path, then a BfsHit. */
function reconstruct(
  prev: ReadonlyMap<number, number>,
  startIdx: number,
  goalIdx: number,
): BfsHit {
  const path: Array<readonly [number, number]> = [];
  let i: number | undefined = goalIdx;
  while (i !== undefined && i !== -1) {
    path.unshift([i % MAP_COLS, Math.floor(i / MAP_COLS)]);
    if (i === startIdx) break;
    i = prev.get(i);
  }

  const target = path[path.length - 1] ?? [
    goalIdx % MAP_COLS,
    Math.floor(goalIdx / MAP_COLS),
  ];
  const dist = path.length - 1;

  let firstDir = Direction.NONE as number;
  if (path.length > 1) {
    const a = path[0];
    const b = path[1];
    if (a !== undefined && b !== undefined) {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      for (const d of DIRECTION_ORDER) {
        if (dirDX(d) === dx && dirDY(d) === dy) {
          firstDir = d;
          break;
        }
      }
    }
  }

  return { firstDir, dist, target };
}

/**
 * BFS from (fromX, fromY) over `passable`, returning EVERY reachable tile with
 * its step distance and the FIRST-step direction (from the start tile) that
 * leads toward it. Read-only and prng-free, like the rest of this module —
 * never mutates SimState and never touches `state.prng`. Neighbors expand in
 * DIRECTION_ORDER for reproducibility. The START tile is EXEMPT from `passable`
 * (callers already stand there) and is always included as
 * { dist: 0, firstDir: Direction.NONE }. The map is keyed by idx(x, y).
 */
export function bfsReachable(
  state: SimState,
  fromX: number,
  fromY: number,
  passable: Passable,
): Map<number, { dist: number; firstDir: number }> {
  const startIdx = idx(fromX, fromY);
  const out = new Map<number, { dist: number; firstDir: number }>();
  out.set(startIdx, { dist: 0, firstDir: Direction.NONE as number });

  const queue: number[] = [startIdx];
  let cursor = 0;

  while (cursor < queue.length) {
    const cur = queue[cursor];
    cursor += 1;
    if (cur === undefined) continue;
    const cx = cur % MAP_COLS;
    const cy = Math.floor(cur / MAP_COLS);
    const curInfo = out.get(cur);
    if (curInfo === undefined) continue;
    const isStart = cur === startIdx;

    for (const d of DIRECTION_ORDER) {
      const nx = cx + dirDX(d);
      const ny = cy + dirDY(d);
      if (!inBounds(nx, ny)) continue;
      const nIdx = idx(nx, ny);
      if (out.has(nIdx)) continue;
      if (!passable(nx, ny)) continue;
      const firstDir = isStart ? d : curInfo.firstDir;
      out.set(nIdx, { dist: curInfo.dist + 1, firstDir });
      queue.push(nIdx);
    }
  }
  return out;
}

/** Passable predicate: tile is enterable terrain with no bomb on it. */
export function openPassable(state: SimState): Passable {
  return (x, y) => isOpen(state.map, state.bombs, x, y);
}

/**
 * Wrap a base passability predicate so it ALSO rejects any tile that is on fire
 * now or whose fire arrives within `horizon` ticks (per `danger`). Used for all
 * non-emergency movement so the bot never strolls into a live melt-flow / a tile
 * that is about to ignite — the single biggest source of self-kills was the bot
 * stepping into the lingering flames of its own just-detonated bomb (whose
 * BombState is already gone, but whose explosion cells live on for SPARK_TICKS).
 * The bot's OWN tile is exempt (callers must already be standing somewhere they
 * accept); only steps INTO new tiles are gated.
 */
export function dangerAwarePassable(
  base: Passable,
  danger: DangerMap,
  horizon: number,
): Passable {
  return (x, y) => {
    if (!base(x, y)) return false;
    const dt = danger.until.get(idx(x, y));
    return dt === undefined || dt > horizon;
  };
}

/**
 * Passable predicate that lets soft bricks count as goals/path tiles (used to
 * pathfind toward something to blow up): in bounds, not HARD, and no bomb.
 */
export function softPassable(state: SimState): Passable {
  return (x, y) => {
    if (!inBounds(x, y)) return false;
    const t = state.map[idx(x, y)];
    return t !== TileKind.HARD && bombAt(state.bombs, x, y) === undefined;
  };
}

/** A what-if bomb (not added to any state) for danger projection. */
export function hypotheticalBomb(
  tileX: number,
  tileY: number,
  fire: number,
  ownerSlot: number,
): BombState {
  return { ownerSlot, tileX, tileY, fuseTicks: FUSE_TICKS, fire };
}

/** tileIndex → earliest tick until fire covers it (0 = on fire now). */
export interface DangerMap {
  readonly until: ReadonlyMap<number, number>;
}

/** Cross-arm deltas in DIRECTION_ORDER (UP, DOWN, LEFT, RIGHT). */
const ARM_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

/**
 * Predict which tiles will be on fire and how soon. `extra` lets callers fold
 * in hypothetical bombs without touching SimState. See the module docblock for
 * the conservative chain rule. Tiles already covered by a live explosion are
 * forced to 0.
 */
export function predictDanger(
  state: SimState,
  extra?: readonly BombState[],
): DangerMap {
  const until = new Map<number, number>();
  const minSet = (i: number, ticks: number): void => {
    const cur = until.get(i);
    if (cur === undefined || ticks < cur) until.set(i, ticks);
  };

  const bombs = extra === undefined ? state.bombs : [...state.bombs, ...extra];

  for (const b of bombs) {
    minSet(idx(b.tileX, b.tileY), b.fuseTicks);
    for (const [dx, dy] of ARM_DELTAS) {
      for (let step = 1; step <= b.fire; step++) {
        const tx = b.tileX + dx * step;
        const ty = b.tileY + dy * step;
        if (!inBounds(tx, ty)) break;
        const t = state.map[idx(tx, ty)];
        if (t === TileKind.HARD) break;
        if (t === TileKind.SOFT) {
          minSet(idx(tx, ty), b.fuseTicks);
          break;
        }
        // EMPTY tile: mark it; if another bomb sits here the real sim would
        // chain and stop, but we conservatively keep flowing outward.
        minSet(idx(tx, ty), b.fuseTicks);
      }
    }
  }

  // Live explosion cells are on fire right now.
  for (const c of state.explosions) {
    minSet(idx(c.tileX, c.tileY), 0);
  }

  return { until };
}

/** Earliest danger tick for a tile index, or undefined if currently safe. */
export function tileDangerTicks(
  danger: DangerMap,
  tileIndex: number,
): number | undefined {
  return danger.until.get(tileIndex);
}

/**
 * A tile is safe if it is in bounds, not in the danger map, and not currently
 * covered by a live explosion. Out-of-bounds tiles are never safe.
 */
export function isSafeTile(
  state: SimState,
  danger: DangerMap,
  x: number,
  y: number,
): boolean {
  if (!inBounds(x, y)) return false;
  if (danger.until.has(idx(x, y))) return false;
  return !explosionAt(state.explosions, x, y);
}

/**
 * BFS over walkable tiles to the nearest currently-safe tile (per `danger`).
 * Returns the safe tile coords, or null if none is reachable.
 */
export function findNearestSafe(
  state: SimState,
  fromX: number,
  fromY: number,
  danger: DangerMap,
): readonly [number, number] | null {
  const hit = bfsFirstStep(
    state,
    fromX,
    fromY,
    (x, y) => isSafeTile(state, danger, x, y),
    openPassable(state),
  );
  return hit === null ? null : hit.target;
}
