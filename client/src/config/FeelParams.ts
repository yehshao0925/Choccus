/**
 * FeelParams — panel-adjustable feel parameters, frozen per match.
 *
 * This is config, not sim: it is Pixi-free and may be imported by both
 * `sim/` and `render/`. The sim never reads these floats directly during a
 * tick — it stores the derived integers (see the helpers below) inside
 * `SimState.params` at match start so the whole tick path stays integer-only.
 */
import {
  DEFAULT_CORNER_ASSIST,
  DEFAULT_INPUT_BUFFER_MS,
  DEFAULT_MOVE_SPEED,
  MILLITILE,
  TICK_HZ,
} from '../../../shared/constants';

export interface FeelParams {
  /** Move speed in tiles/s (spec range 3–8). */
  readonly moveSpeed: number;
  /** Corner-assist tolerance in tiles (spec range 0–0.5). Named to match the
   *  wire field `cornerAssist` (shared/protocol.ts) so the two never drift. */
  readonly cornerAssist: number;
  /** Input buffer in ms (spec range 0–250). */
  readonly inputBufferMs: number;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Build a frozen FeelParams, clamping every field to its spec range. */
export function makeFeelParams(partial?: Partial<FeelParams>): FeelParams {
  return Object.freeze({
    moveSpeed: clamp(partial?.moveSpeed ?? DEFAULT_MOVE_SPEED, 3, 8),
    cornerAssist: clamp(
      partial?.cornerAssist ?? DEFAULT_CORNER_ASSIST,
      0,
      0.5,
    ),
    inputBufferMs: clamp(partial?.inputBufferMs ?? DEFAULT_INPUT_BUFFER_MS, 0, 250),
  });
}

// ---------------------------------------------------------------------------
// Derived integers for the sim (computed once at match start, then stored)
// ---------------------------------------------------------------------------

/** Base move speed in millitiles/s (int). Default 5.0 → 5000. */
export function moveSpeedMt(fp: FeelParams): number {
  return Math.round(fp.moveSpeed * MILLITILE);
}

/** Base move speed in millitiles/tick (int). Default 5.0 → 83. */
export function moveSpeedMtPerTick(fp: FeelParams): number {
  return Math.round((fp.moveSpeed * MILLITILE) / TICK_HZ);
}

/** Corner-assist tolerance in millitiles (int). Default 0.25 → 250. */
export function cornerAssistMt(fp: FeelParams): number {
  return Math.round(fp.cornerAssist * MILLITILE);
}

/** Input buffer window in ticks (int). Default 120 ms → 7. */
export function inputBufferTicks(fp: FeelParams): number {
  return Math.round((fp.inputBufferMs * TICK_HZ) / 1000);
}
