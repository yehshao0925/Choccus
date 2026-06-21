/**
 * GoalCommitment — anti-dither goal hysteresis for the v2 forward-search bot.
 *
 * IMPORTANT (CLAUDE.md rule): this is NOT a discrete two-phase mode FSM
 * (炸牆模式/對戰模式). It is a small struct that records the bot's CURRENT goal
 * (FIGHT a foe / FARM bricks) and feeds a single INTEGER anti-backtrack PENALTY
 * into the forward-search leaf evaluation. The search still enumerates all six
 * root candidates and picks the maximin winner; this only shifts scores enough
 * to kill oscillation. W_SURVIVE (1000) dominates, so survivability always wins —
 * ANTI_BACKTRACK_PENALTY (80) is far below it on purpose.
 *
 * Zero RNG, all integer; pure view (never touches SimState / its prng).
 */
import { idx } from '../../../sim/Map';

/** Ticks a FIGHT goal is held before a challenger can flip it. */
export const FIGHT_HOLD_TICKS = 20;
/** Ticks a FARM goal is held before a challenger can flip it. */
export const FARM_HOLD_TICKS = 12;
/**
 * Integer penalty added at a search leaf when the bot RE-ENTERS the tile it just
 * left (the anti-backtrack tile). Far below W_SURVIVE (1000) so it can only
 * break dithering ties, never trade away survivability.
 */
export const ANTI_BACKTRACK_PENALTY = 80;
/**
 * Score margin a CHALLENGER goal must beat the COMMITTED goal by before the bot
 * is allowed to switch goals while a commitment is still active (hysteresis).
 */
export const COMMIT_HYSTERESIS = 120;

export type GoalKind = 'FIGHT' | 'FARM' | null;

export class GoalCommitment {
  /** Current committed goal kind, or null when inactive. */
  kind: GoalKind = null;
  /** Target tile of the current goal (-1 = none). */
  targetX = -1;
  targetY = -1;
  /** Ticks remaining on the current commitment. */
  holdTicks = 0;
  /** Tile index the bot just LEFT; re-entering it is penalized (-1 = none). */
  antiBacktrackTileIdx = -1;
  /** The penalty applied for re-entering antiBacktrackTileIdx. */
  antiBacktrackPenalty = ANTI_BACKTRACK_PENALTY;

  /**
   * Commit to a new goal. BEFORE overwriting the target, record the PREVIOUS
   * target tile as the anti-backtrack tile so re-entering the just-left tile is
   * penalized. Passing prevX/prevY (the bot's current tile this decision)
   * records where we are leaving FROM.
   */
  update(
    tx: number,
    ty: number,
    kind: GoalKind,
    holdTicks: number,
    prevX: number,
    prevY: number,
  ): void {
    if (prevX >= 0 && prevY >= 0 && (prevX !== tx || prevY !== ty)) {
      this.antiBacktrackTileIdx = idx(prevX, prevY);
    }
    this.kind = kind;
    this.targetX = tx;
    this.targetY = ty;
    this.holdTicks = holdTicks;
  }

  /** Decrement the hold counter toward 0 (called once per decision tick). */
  tick(): void {
    if (this.holdTicks > 0) this.holdTicks -= 1;
  }

  /** True while a goal is actively committed. */
  isActive(): boolean {
    return this.holdTicks > 0 && this.targetX >= 0;
  }

  /** Anti-backtrack penalty for ending a search leaf on tile (rx,ry). */
  penaltyFor(rx: number, ry: number): number {
    if (this.antiBacktrackTileIdx < 0) return 0;
    return idx(rx, ry) === this.antiBacktrackTileIdx
      ? this.antiBacktrackPenalty
      : 0;
  }

  /** Drop the commitment but KEEP the anti-backtrack tile (a soft interrupt). */
  interrupt(): void {
    this.kind = null;
    this.targetX = -1;
    this.targetY = -1;
    this.holdTicks = 0;
  }

  /** Fully reset to inactive (clears the anti-backtrack tile too). */
  clear(): void {
    this.kind = null;
    this.targetX = -1;
    this.targetY = -1;
    this.holdTicks = 0;
    this.antiBacktrackTileIdx = -1;
  }
}
