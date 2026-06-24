/**
 * Render-side interpolation helpers (Pixi-free math, but render-only —
 * never imported by sim/).
 *
 * The sim advances in whole 60 Hz ticks; the renderer runs on rAF and blends
 * entity positions between the previous and next SimState with `alpha` =
 * fraction of the current tick already elapsed.
 *
 * Entity matching (who interpolates against whom):
 * - players: by `slot` (stable for the whole match);
 * - bombs / items / explosion cells: tile-locked, they never move, so they
 *   render straight from the next state without interpolation.
 *
 * SNAP rule: if the prev→next displacement exceeds 3 tiles (respawn,
 * teleport, index mismatch), render at the next position with no lerp.
 */
import { MILLITILE } from '../../../shared/constants';

export function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

/** Prev→next jumps beyond this (per axis) snap instead of lerping. */
export const SNAP_THRESHOLD_MT = 3 * MILLITILE;
