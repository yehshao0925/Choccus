/**
 * Interval-aware blast danger model for the scoring-loop bot.
 *
 * This is a PURE, prng-free, read-only view over SimState (like grid.ts): it
 * NEVER mutates SimState / its typed-array map and NEVER reads or advances
 * `state.prng`, so it cannot perturb the lockstep golden hashes. No randomness,
 * no wall-clock, no floating-point: everything is integer ticks and integer
 * tile coordinates, iterated in fixed order.
 *
 * WHY an interval model (and not predictDanger's "earliest tick" map): the old
 * danger map collapsed a bomb's threat to a single "ticks until fire" number,
 * which cannot answer "is tile T lethal AT tick K?" — the question the scoring
 * loop needs to count tiles that stay safe across a whole planning horizon. A
 * lingering melt-flow is lethal for a 27-tick WINDOW, not an instant, so a tile
 * can be safe now, lethal at the detonation, then safe again. We therefore store
 * per-tile lethal INTERVALS [start, end) and answer isLethal(tile, tick) exactly.
 *
 * EXACT ALIGNMENT WITH client/src/sim/Explosion.ts processDetonations():
 * - Detonation FIFO/chain: detonations are processed in bomb-array order; an arm
 *   that reaches an EMPTY tile holding another undetonated bomb CHAINS it the
 *   SAME tick and STOPS there. We replicate this with a SINGLE FIFO queue +
 *   detonated[] flag array bounded by bombs.length (mirroring processDetonations)
 *   drained by a persistent-cursor helper, so a bomb chained at ANY point —
 *   including one discovered while force-detonating the fixed-order tail — is
 *   stamped exactly once. Each bomb's detonateTick = min(its own fuse countdown,
 *   the tick the arm that chained it arrived) via MIN over all detonations.
 * - Lethal windows per the sim's cell rules:
 *     • center tile + EMPTY arm cells get a flame cell that lives SPARK_TICKS →
 *       lethal interval [t, t + SPARK_TICKS).
 *     • a SOFT brick on an arm is destroyed, the arm STOPS, and the cleared tile
 *       gets NO flame cell — it is lethal ONLY on the exact detonate tick (the
 *       brick is solid right up to detonation), window [t, t + 1).
 *     • HARD / off-map → arm stops, no cell.
 *     • a chained bomb's own tile is covered by the chained bomb's center cell,
 *       so the chaining arm STOPS without stamping a cell there (the chained
 *       bomb stamps that tile itself).
 * - Already-live state.explosions cells: lethal NOW through their remaining
 *   ttlTicks, i.e. interval [0, ttlTicks).
 *
 * Bounded for performance: 15×13 map, horizon ≈ FUSE_TICKS + SPARK_TICKS.
 */
import type { SimState } from '../../sim/Sim';
import type { BombState } from '../../sim/Bomb';
import { idx, inBounds } from '../../sim/Map';
import { MAP_COLS, MAP_ROWS, SPARK_TICKS } from '../../../../shared/constants';
import { TileKind } from '../../../../shared/types';

/** Cross-arm deltas in DIRECTION_ORDER (UP, DOWN, LEFT, RIGHT). */
const ARM_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

const TILE_COUNT = MAP_COLS * MAP_ROWS;

/** Half-open lethal window [start, end) on one tile. */
interface Interval {
  start: number;
  end: number;
}

export interface IntervalDanger {
  /** True if tile `tileIdx` is on fire at the (integer) tick `tick`. */
  isLethal(tileIdx: number, tick: number): boolean;
  /**
   * True if tile `tileIdx` is lethal at ANY tick in the half-open range
   * [start, end). O(intervals on the tile) — far cheaper than probing every
   * tick, used by the bomb-drop gate to test a whole planning window at once.
   */
  lethalBetween(tileIdx: number, start: number, end: number): boolean;
  /** Earliest tick this tile ever becomes lethal, or undefined if never. */
  earliestLethal(tileIdx: number): number | undefined;
}

/**
 * Build the interval danger model for `state` plus any `extraBombs` (e.g. a
 * hypothetical bomb the bot is considering). Pure / prng-free.
 */
export function buildDangerMap(
  state: SimState,
  extraBombs?: readonly BombState[],
): IntervalDanger {
  // Full bomb set in FIXED array order (state bombs first, then extras): the
  // chain FIFO and detonated[] indices key off this exact ordering.
  const bombs: BombState[] =
    extraBombs === undefined || extraBombs.length === 0
      ? state.bombs.slice()
      : [...state.bombs, ...extraBombs];
  const n = bombs.length;

  // detonateTick[i] = tick at which bomb i melts. Start at its own fuse; lowered
  // to the arm-arrival tick if an earlier-detonating bomb chains it. MIN wins.
  const detonateTick: number[] = bombs.map((b) => b.fuseTicks);
  const detonated: boolean[] = bombs.map(() => false);
  const queue: number[] = [];

  // Seed the FIFO with bombs whose fuse already expired (mirrors the sim's
  // initial pass), in fixed array order.
  for (let i = 0; i < n; i++) {
    const b = bombs[i];
    if (b !== undefined && b.fuseTicks <= 0) {
      detonated[i] = true;
      queue.push(i);
    }
  }

  // Per-tile lethal intervals, fixed iteration order (index ascending).
  const intervals: Array<Interval[]> = new Array<Interval[]>(TILE_COUNT);
  const stamp = (i: number, start: number, end: number): void => {
    let list = intervals[i];
    if (list === undefined) {
      list = [];
      intervals[i] = list;
    }
    list.push({ start, end });
  };

  // Process bomb i's detonation at tick `t`: stamp its covered cells and chain.
  const processBomb = (bi: number): void => {
    const bomb = bombs[bi];
    if (bomb === undefined) return;
    const t = detonateTick[bi] ?? bomb.fuseTicks;
    // Center cell: full spark window.
    stamp(idx(bomb.tileX, bomb.tileY), t, t + SPARK_TICKS);

    for (const delta of ARM_DELTAS) {
      const dx = delta[0]!;
      const dy = delta[1]!;
      for (let step = 1; step <= bomb.fire; step++) {
        const tx = bomb.tileX + dx * step;
        const ty = bomb.tileY + dy * step;
        if (!inBounds(tx, ty)) break;
        const tile = idx(tx, ty);
        const kind = state.map[tile];
        if (kind === TileKind.HARD) break;
        if (kind === TileKind.SOFT) {
          // Brick is solid until detonation, cleared at t with NO flame cell →
          // lethal only on the exact detonate tick.
          stamp(tile, t, t + 1);
          break;
        }
        // EMPTY tile: chain an undetonated bomb sitting here (same tick), and
        // STOP — the chained bomb's own center cell will cover this tile, so we
        // do NOT stamp a flame cell here.
        let chained = false;
        for (let j = 0; j < n; j++) {
          const other = bombs[j];
          if (
            other !== undefined &&
            !detonated[j] &&
            other.tileX === tx &&
            other.tileY === ty
          ) {
            detonated[j] = true;
            // The chained bomb melts at min(its own fuse, this arm's tick).
            const cur = detonateTick[j] ?? other.fuseTicks;
            detonateTick[j] = Math.min(cur, t);
            queue.push(j);
            chained = true;
            break;
          }
        }
        if (chained) break;
        // Plain EMPTY tile gets a flame cell for the full spark window.
        stamp(tile, t, t + SPARK_TICKS);
      }
    }
  };

  // SINGLE bounded FIFO with a PERSISTENT cursor. `drain()` processes every
  // queued bomb (including chains pushed DURING processing, since the loop
  // re-reads queue.length each iteration) and never re-processes one (the
  // cursor only advances). The cursor survives across drain() calls so a bomb
  // chained while draining the fallback-seeded tail is still stamped exactly
  // once — fixing the old bug where a chain discovered after the FIFO loop had
  // finished was marked `detonated` but never stamped (under-marking → unsafe).
  let cursor = 0;
  const drain = (): void => {
    while (cursor < queue.length) {
      const bi = queue[cursor];
      cursor += 1;
      if (bi === undefined) continue;
      processBomb(bi);
    }
  };

  // Drain the fuse<=0 seed and everything it chains.
  drain();
  // Then, in fixed array order, force every remaining bomb to detonate at its
  // own fuse tick, draining each so any bombs IT chains are also stamped. Once
  // drained, the cursor sits at queue.length, so each pushed bomb is picked up
  // by the very next drain() and stamped exactly once.
  for (let i = 0; i < n; i++) {
    if (!detonated[i]) {
      detonated[i] = true;
      queue.push(i);
      drain();
    }
  }

  // Live explosion cells: lethal NOW through their remaining ttl → [0, ttl).
  for (const c of state.explosions) {
    if (!inBounds(c.tileX, c.tileY)) continue;
    stamp(idx(c.tileX, c.tileY), 0, c.ttlTicks);
  }

  return {
    isLethal(tileIdx: number, tick: number): boolean {
      const list = intervals[tileIdx];
      if (list === undefined) return false;
      for (const iv of list) {
        if (tick >= iv.start && tick < iv.end) return true;
      }
      return false;
    },
    lethalBetween(tileIdx: number, start: number, end: number): boolean {
      const list = intervals[tileIdx];
      if (list === undefined) return false;
      // Half-open [start, end) overlaps [iv.start, iv.end) iff
      // iv.start < end && start < iv.end.
      for (const iv of list) {
        if (iv.start < end && start < iv.end) return true;
      }
      return false;
    },
    earliestLethal(tileIdx: number): number | undefined {
      const list = intervals[tileIdx];
      if (list === undefined) return undefined;
      let best: number | undefined;
      for (const iv of list) {
        if (best === undefined || iv.start < best) best = iv.start;
      }
      return best;
    },
  };
}
