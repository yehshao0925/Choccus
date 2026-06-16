/**
 * BotController — a deterministic AI "brain" that turns the SimState it observes
 * into one InputFrame per tick (move direction + bomb action).
 *
 * ARCHITECTURE (single weighted scoring loop):
 * Instead of a hierarchical flee>rescue>attack>farm if-else tree, every decision
 * tick enumerates a FIXED candidate set [STAY, UP, DOWN, LEFT, RIGHT, PLACE_BOMB],
 * scores each with one integer weighted sum
 *     score(a) = W_SURVIVE*survivability + W_RESCUE*rescue + W_ATTACK(state)*pressure
 *              + W_ECON*economy + W_POSITION*position
 * and picks the highest (strict `>`, first candidate wins ties). "Phase" behaviour
 * (defend / hunt / farm) EMERGES from the continuous attack weight, which scales
 * with map progress, foe proximity, and the archetype's `aggression` knob — there
 * is no mode switch.
 *
 * Layered ABOVE the scoring loop, in this order at the top of sample():
 *   1. dead/trapped early-out → NO_INPUT;
 *   2. post-bomb escape commitment (runEscape): after we drop a bomb we run,
 *      undistracted, to the refuge we validated, re-checking it every tick;
 *   3. replan inertia (repeat the committed dir between decision ticks) and the
 *      humanizing reaction-delay freeze when a fresh threat to our tile appears.
 *
 * Determinism contract (MUST hold so it cannot perturb lockstep golden hashes):
 * - PURE function of (its own carried RNG state, observed SimState) → InputFrame.
 *   NEVER reads or advances `SimState.prng`; randomness flows ONLY through
 *   randFloat()/randInt() (Mulberry32 threaded onto this.rng).
 * - NO Math.random / Date.now / performance.now / Math.sqrt / Math.sin / Math.cos.
 *   Distances are BFS step counts or integer Manhattan; all scores are INTEGERS
 *   (no float in the weighted sum). Candidate order is fixed; ties resolve to the
 *   first candidate via strict `>`.
 * - Bombs are placed on a RISING EDGE: action = ActionFlags.BOMB only on the tick
 *   we drop, ActionFlags.NONE otherwise. `dir` is always a single Direction bit.
 *
 * The interval blast model (buildDangerMap) answers "is tile T lethal AT tick K?"
 * exactly, which the survivability term and the PLACE_BOMB safety gate require.
 * The cheap "earliest-fire" grid.predictDanger is reused for the escape-commit
 * path (already validated against self-trap).
 */
import type { SimState } from '../../sim/Sim';
import { type InputFrame, DIRECTION_ORDER, NO_INPUT } from '../../sim/InputBuffer';
import { idx, inBounds } from '../../sim/Map';
import { dirDX, dirDY, playerSpeedMtPerTick, tileOf } from '../../sim/Player';
import { bombAt } from '../../sim/Bomb';
import {
  FUSE_TICKS,
  MAP_COLS,
  MAP_ROWS,
  MILLITILE,
  SPARK_TICKS,
} from '../../../../shared/constants';
import { ActionFlags, Direction, ItemKind, TileKind } from '../../../../shared/types';
import type { BotTuning } from './BotConfig';
import { botRandFloat, botRandInt } from './BotConfig';
import {
  type DangerMap,
  type Passable,
  bfsFirstStep,
  dangerAwarePassable,
  findNearestSafe,
  hypotheticalBomb,
  isSafeTile,
  openPassable,
  predictDanger,
  tileDangerTicks,
} from '../common/grid';
import { type IntervalDanger, buildDangerMap } from '../common/dangerMap';

// Live bot = current AI_VERSION (see version.ts)
export { AI_VERSION } from './version';

// ---------------------------------------------------------------------------
// Timing / horizon constants
// ---------------------------------------------------------------------------

/** Extra ticks of slack over the bare travel estimate (reaction + alignment). */
const TRAVEL_SLACK_TICKS = 8;

/**
 * Spark cushion (ticks) we keep between arriving safe and the bomb melting.
 * Comfortably above SPARK_TICKS (27) so we are clear before flames spread.
 */
const ESCAPE_SAFETY_TICKS = 32;

/** Force a decision + fresh random direction after this many stuck ticks. */
const STUCK_TICKS = 90;

/** Hard cap on how long we stay committed to an escape route before bailing. */
const ESCAPE_COMMIT_MAX_TICKS = 120;

/**
 * Near-horizon (ticks) for danger-aware passability and "is the result tile
 * about to ignite" checks. A tile whose fire arrives within this window is too
 * dangerous to count as a refuge / step into. Sized above SPARK_TICKS so we
 * never walk into a lingering melt-flow.
 */
const STEP_DANGER_HORIZON = SPARK_TICKS + 4;

// ---------------------------------------------------------------------------
// Scoring weights (integer; W_SURVIVE highest, W_POSITION smallest). Each term
// returns a small bounded non-negative integer, so the weighted sum cannot
// overflow and survivability always dominates.
// ---------------------------------------------------------------------------
const W_SURVIVE = 1000;
const W_RESCUE = 120;
const W_ATTACK_BASE = 60;
const W_ECON = 20;
const W_POSITION = 3;

/** survivability flood cap: visited-tile budget and per-tile safe-margin cap. */
const SURV_FLOOD_CAP = 24;
const SURV_MARGIN_CAP = 8;
/** Result tile lethal within this many ticks → survivability ~0 (reaction). */
const SURV_REACTION_WINDOW = SPARK_TICKS + 4;
/**
 * A tile that stays non-lethal for at least this many ticks counts as TRUE
 * safety (a refuge), not merely a fleeting gap. Sized near a full fuse so a
 * tile threatened by a not-yet-melted bomb is not mistaken for a refuge.
 */
const SURV_SAFE_HORIZON = FUSE_TICKS;
/** Bonus a truly-safe (never-lethal-within-horizon) tile adds to survivability. */
const SURV_SAFE_BONUS = 6;

/** Reference soft-brick count for the aggression progress factor. */
const TOTAL_SOFT_REF = 80;

/** Center tile (used by positionValue): floor(MAP_COLS/2), floor(MAP_ROWS/2). */
const CENTER_X = Math.floor(MAP_COLS / 2); // 7
const CENTER_Y = Math.floor(MAP_ROWS / 2); // 6

/** Item-priority weights for economyValue: CANNON > FIRE > SPEED. */
const ITEM_PRIORITY: Readonly<Record<number, number>> = {
  [ItemKind.CANNON]: 3,
  [ItemKind.FIRE]: 2,
  [ItemKind.SPEED]: 1,
};

/** A scored candidate action. */
interface Candidate {
  /** Direction bit for a move, Direction.NONE for STAY / PLACE_BOMB. */
  dir: number;
  /** True for the PLACE_BOMB candidate. */
  bomb: boolean;
  /** Result tile after the action (= current tile for STAY / PLACE_BOMB). */
  rx: number;
  ry: number;
  /** Integer score (-Infinity = illegal). */
  score: number;
  /**
   * True iff the result tile stays non-lethal through the reaction window
   * (survivability term > 0). A mistake may only fall back to a survivability-
   * safe candidate — never one that walks straight into a live melt-flow.
   */
  survSafe: boolean;
  /** For a gate-valid PLACE_BOMB: the validated refuge to commit to. */
  refugeX: number;
  refugeY: number;
}

export class BotController {
  /** Threaded bot-private uint32 RNG state (never SimState.prng). */
  private rng: number;
  private readonly tuning: BotTuning;
  /** Ctor slot — for debug/seed only; sample()'s slot arg takes precedence. */
  private readonly ctorSlot: number;

  /** Committed move direction (replan inertia); 0 = none committed. */
  private committedDir = Direction.NONE as number;
  /** Ticks remaining on the committed direction before a forced replan. */
  private committedTicks = 0;

  /** Reaction-delay countdown after a fresh threat is first seen. */
  private reactionTimer = 0;
  /** Whether a threat to our tile was already pending last tick. */
  private threatPending = false;

  /** Stuck detector: last tile index and ticks since it last changed. */
  private lastTile = -1;
  private ticksSinceTileChange = 0;

  /**
   * Post-bomb escape commitment. After dropping a bomb we lock onto the safe
   * tile we just validated and walk straight there, dropping no new bomb until
   * we arrive. -1 X means "no commitment".
   */
  private escapeTargetX = -1;
  private escapeTargetY = -1;
  private escapeTicks = 0;

  constructor(rngSeed: number, tuning: BotTuning, slot: number) {
    this.rng = rngSeed >>> 0;
    this.tuning = tuning;
    this.ctorSlot = slot;
  }

  /** Bot-private uniform float in [0, 1); threads the RNG state forward. */
  private randFloat(): number {
    const [v, s] = botRandFloat(this.rng);
    this.rng = s;
    return v;
  }

  /** Bot-private uniform int in [min, maxIncl]; threads the RNG state forward. */
  private randInt(min: number, maxIncl: number): number {
    const [v, s] = botRandInt(this.rng, min, maxIncl);
    this.rng = s;
    return v;
  }

  /** True if the neighbor of (x,y) in direction `d` satisfies `passable`. */
  private dirOk(x: number, y: number, d: number, passable: Passable): boolean {
    const nx = x + dirDX(d);
    const ny = y + dirDY(d);
    if (!inBounds(nx, ny)) return false;
    return passable(nx, ny);
  }

  /** Directions (single bits) from (x,y) satisfying `passable`, in order. */
  private dirsWith(x: number, y: number, passable: Passable): number[] {
    const out: number[] = [];
    for (const d of DIRECTION_ORDER) {
      if (this.dirOk(x, y, d, passable)) out.push(d);
    }
    return out;
  }

  /**
   * Pick a random direction from (x,y) that is safe to enter (per `passable`).
   * Returns Direction.NONE when no safe direction exists — holding still on our
   * currently-safe tile beats walking into flames.
   */
  private randomSafeDir(x: number, y: number, passable: Passable): number {
    const safe = this.dirsWith(x, y, passable);
    if (safe.length === 0) return Direction.NONE;
    const pick = safe[this.randInt(0, safe.length - 1)];
    return pick ?? Direction.NONE;
  }

  /** Commit a direction for the replan interval. */
  private commit(dir: number): void {
    this.committedDir = dir;
    this.committedTicks = this.tuning.replanIntervalTicks;
  }

  /** Clear any post-bomb escape commitment. */
  private clearEscape(): void {
    this.escapeTargetX = -1;
    this.escapeTargetY = -1;
    this.escapeTicks = 0;
  }

  /** Whether we are currently committed to running to a post-bomb refuge. */
  private hasEscape(): boolean {
    return this.escapeTargetX >= 0;
  }

  /**
   * Ticks needed to cross one tile at the player's current speed. Derived from
   * FeelParams + speed-bonus items (never hardcoded). Always >= 1.
   */
  private ticksPerTile(state: SimState, speedBonusTenths: number): number {
    const perTick = playerSpeedMtPerTick(
      state.params.moveSpeedMt,
      speedBonusTenths,
    );
    if (perTick <= 0) return MILLITILE; // pathological: treat as ~unmovable.
    return Math.ceil(MILLITILE / perTick);
  }

  /**
   * Can the player walk `dist` tiles and be safely clear before a just-placed
   * bomb (fuse = `fuseTicks`) melts? Adds a reaction/alignment slack and a
   * spark cushion. Pure timing check used to gate bomb drops.
   */
  private escapeFitsInFuse(
    fuseTicks: number,
    dist: number,
    ticksPerTile: number,
  ): boolean {
    const travel = dist * ticksPerTile;
    const needed =
      travel +
      this.tuning.reactionDelayTicks +
      TRAVEL_SLACK_TICKS +
      ESCAPE_SAFETY_TICKS;
    return needed <= fuseTicks;
  }

  /**
   * Tiles occupied by an ATTACKABLE foe = an enemy-team PLAYER (different team,
   * alive, not trapped, different slot). Computed once per sample().
   */
  private foeTiles(state: SimState, slot: number, myTeam: number): Set<number> {
    const tiles = new Set<number>();
    for (const p of state.players) {
      if (p.slot === slot || !p.alive || p.trapped) continue;
      if (p.team === myTeam) continue;
      tiles.add(idx(tileOf(p.posX), tileOf(p.posY)));
    }
    return tiles;
  }

  /**
   * Count SOFT bricks a bomb at (x,y) reach `fire` would destroy. Scans the 4
   * arms in DIRECTION_ORDER, stops at the first HARD, counts (+1) the first SOFT
   * — mirrors Explosion.ts arm rules. Returns 0..4.
   */
  private softDestroyedAt(
    state: SimState,
    x: number,
    y: number,
    fire: number,
  ): number {
    let count = 0;
    for (const d of DIRECTION_ORDER) {
      const dx = dirDX(d);
      const dy = dirDY(d);
      for (let step = 1; step <= fire; step++) {
        const tx = x + dx * step;
        const ty = y + dy * step;
        if (!inBounds(tx, ty)) break;
        const t = state.map[idx(tx, ty)];
        if (t === TileKind.HARD) break;
        if (t === TileKind.SOFT) {
          count += 1;
          break;
        }
      }
    }
    return count;
  }

  /** Reset transient timers (used when we cannot act this tick). */
  private resetActive(): void {
    this.committedDir = Direction.NONE as number;
    this.committedTicks = 0;
    this.reactionTimer = 0;
    this.threatPending = false;
    this.clearEscape();
  }

  /**
   * Drive the committed post-bomb escape against the cheap earliest-fire grid
   * danger (already battle-tested against self-trap). Re-validates the refuge
   * every tick and re-plans if it stopped being safe/reachable. Returns the
   * InputFrame to use, or null when the commitment is satisfied/abandoned.
   */
  private runEscape(
    state: SimState,
    myX: number,
    myY: number,
    danger: DangerMap,
  ): InputFrame | null {
    if (!this.hasEscape()) return null;

    this.escapeTicks += 1;
    if (this.escapeTicks > ESCAPE_COMMIT_MAX_TICKS) {
      this.clearEscape();
      return null;
    }

    const atTarget = myX === this.escapeTargetX && myY === this.escapeTargetY;
    if (atTarget && isSafeTile(state, danger, myX, myY)) {
      this.clearEscape();
      return null;
    }

    const fireSafe = dangerAwarePassable(
      openPassable(state),
      danger,
      STEP_DANGER_HORIZON,
    );

    const myDanger = tileDangerTicks(danger, idx(myX, myY));
    const targetStillSafe =
      inBounds(this.escapeTargetX, this.escapeTargetY) &&
      isSafeTile(state, danger, this.escapeTargetX, this.escapeTargetY);

    if (!targetStillSafe) {
      const safe = findNearestSafe(state, myX, myY, danger);
      if (safe === null) {
        this.clearEscape();
        return null;
      }
      this.escapeTargetX = safe[0];
      this.escapeTargetY = safe[1];
    }

    const hit = bfsFirstStep(
      state,
      myX,
      myY,
      (x, y) => x === this.escapeTargetX && y === this.escapeTargetY,
      fireSafe,
    );
    if (hit === null) {
      const safe = findNearestSafe(state, myX, myY, danger);
      if (
        safe === null ||
        (safe[0] === myX && safe[1] === myY && myDanger === undefined)
      ) {
        this.clearEscape();
        return null;
      }
      this.escapeTargetX = safe[0];
      this.escapeTargetY = safe[1];
      const retry = bfsFirstStep(
        state,
        myX,
        myY,
        (x, y) => x === this.escapeTargetX && y === this.escapeTargetY,
        fireSafe,
      );
      if (retry === null) {
        this.clearEscape();
        return null;
      }
      return { dir: retry.firstDir, action: ActionFlags.NONE };
    }

    return { dir: hit.firstDir, action: ActionFlags.NONE };
  }

  // -------------------------------------------------------------------------
  // Interval-danger helpers (scoring + gate use the exact-tick model)
  // -------------------------------------------------------------------------

  /**
   * Danger-aware passability against the INTERVAL model: enterable terrain, no
   * bomb, and the tile is not lethal anywhere within the near horizon (so we
   * never path through a tile that ignites while we are crossing it). The
   * start tile is exempt as usual (BFS callers stand there).
   */
  private dangerAwareInterval(
    state: SimState,
    danger: IntervalDanger,
    horizon: number,
  ): Passable {
    const base = openPassable(state);
    return (x, y) => {
      if (!base(x, y)) return false;
      const tIdx = idx(x, y);
      const earliest = danger.earliestLethal(tIdx);
      return earliest === undefined || earliest > horizon;
    };
  }

  /**
   * survivability(a) — HIGHEST weight, NOT boolean. Floods from the result tile
   * (bounded by SURV_FLOOD_CAP) and answers "from here, how good are my breathing
   * options?" — crucially distinguishing a genuine refuge from a DOOMED POCKET
   * (a region every tile of which ignites, e.g. a dead-end column holding the
   * bot's own ticking bomb). The flood expands only through tiles that are not
   * lethal within the near horizon (danger-aware), so we never count breathing
   * room across a tile that ignites while we'd be crossing it.
   *
   * Scoring per reachable tile: a tile that is NEVER lethal across the full
   * escape horizon is true safety and worth SURV_SAFE_BONUS + cap; a tile that
   * eventually ignites is worth only its (capped) time-to-ignite. The result is
   * then heavily dominated by whether ANY never-lethal tile is reachable: a
   * doomed pocket (no never-safe tile reachable) scores tiny, an open area
   * scores large. If the RESULT tile itself ignites within the reaction window
   * → 0 (about to burn where we stand).
   */
  private survivability(
    state: SimState,
    danger: IntervalDanger,
    rx: number,
    ry: number,
  ): number {
    const startIdx = idx(rx, ry);
    const startEarliest = danger.earliestLethal(startIdx);
    if (startEarliest !== undefined && startEarliest <= SURV_REACTION_WINDOW) {
      return 0;
    }

    const base = openPassable(state);
    const visited = new Set<number>([startIdx]);
    const queue: number[] = [startIdx];
    let cursor = 0;
    let total = 0;
    let reachedTrulySafe = false;

    while (cursor < queue.length && visited.size <= SURV_FLOOD_CAP) {
      const cur = queue[cursor];
      cursor += 1;
      if (cur === undefined) continue;
      const cx = cur % MAP_COLS;
      const cy = (cur - cx) / MAP_COLS;
      const earliest = danger.earliestLethal(cur);
      if (earliest === undefined || earliest > SURV_SAFE_HORIZON) {
        // Truly safe: never lethal within the whole escape horizon. This is the
        // breathing room that matters — reward it strongly.
        total += 1 + SURV_MARGIN_CAP + SURV_SAFE_BONUS;
        reachedTrulySafe = true;
      } else if (earliest > SURV_REACTION_WINDOW) {
        // Only TEMPORARILY safe: worth its (capped) time-to-ignite — a fleeting
        // option, not a refuge.
        total += 1 + Math.min(earliest - SURV_REACTION_WINDOW, SURV_MARGIN_CAP);
      }
      // (else: lethal within the reaction window → contributes nothing and we
      //  don't expand through it below.)

      for (const d of DIRECTION_ORDER) {
        const nx = cx + dirDX(d);
        const ny = cy + dirDY(d);
        if (!inBounds(nx, ny)) continue;
        const nIdx = idx(nx, ny);
        if (visited.has(nIdx)) continue;
        if (!base(nx, ny)) continue;
        // Don't flood through a tile that ignites within the near horizon: it
        // would be on fire before we could pass it.
        const nEarliest = danger.earliestLethal(nIdx);
        if (nEarliest !== undefined && nEarliest <= STEP_DANGER_HORIZON) continue;
        visited.add(nIdx);
        queue.push(nIdx);
      }
    }
    // A pocket from which NO never-lethal tile is reachable is a death trap:
    // collapse its score so STAY/move out of it never beats a real refuge.
    if (!reachedTrulySafe) return Math.min(total, 1);
    return total;
  }

  /**
   * rescueValue(a) — a TERM, not a mode. Nearest TRAPPED same-team teammate,
   * BFS distance from the RESULT tile over open passability; value scaled by
   * max(0, remainingTrappedTicks - bfsDist*ticksPerTile). 0 if none / cannot
   * reach in time.
   */
  private rescueValue(
    state: SimState,
    slot: number,
    myTeam: number,
    rx: number,
    ry: number,
    ticksPerTile: number,
  ): number {
    let best = 0;
    for (const p of state.players) {
      if (p.slot === slot || p.team !== myTeam) continue;
      if (!p.alive || !p.trapped) continue;
      const tx = tileOf(p.posX);
      const ty = tileOf(p.posY);
      const hit = bfsFirstStep(
        state,
        rx,
        ry,
        (x, y) => x === tx && y === ty,
        openPassable(state),
      );
      if (hit === null) continue;
      const arrive = hit.dist * ticksPerTile;
      if (arrive > p.trappedTicks) continue; // cannot reach before shell breaks.
      // Closer + more time left ⇒ higher (small bounded integer).
      const v = Math.floor((p.trappedTicks - arrive) / 10) + 1;
      if (v > best) best = v;
    }
    return best;
  }

  /**
   * Cross-arm rule shared with Explosion.ts: from (x,y), reach `fire`, return
   * the set of tiles a blast would cover (center + arm cells up to first HARD,
   * stopping at and INCLUDING the first SOFT). Used by enemyPressure to test
   * whether a hypothetical bomb hits a foe / a teammate.
   */
  private blastTiles(
    state: SimState,
    x: number,
    y: number,
    fire: number,
  ): Set<number> {
    const out = new Set<number>([idx(x, y)]);
    for (const d of DIRECTION_ORDER) {
      const dx = dirDX(d);
      const dy = dirDY(d);
      for (let step = 1; step <= fire; step++) {
        const tx = x + dx * step;
        const ty = y + dy * step;
        if (!inBounds(tx, ty)) break;
        const t = state.map[idx(tx, ty)];
        if (t === TileKind.HARD) break;
        out.add(idx(tx, ty));
        if (t === TileKind.SOFT) break; // arm stops at the soft brick.
      }
    }
    return out;
  }

  /** Open neighbours of (x,y) that are NON-LETHAL within the near horizon. */
  private safeOpenNeighborCount(
    state: SimState,
    danger: IntervalDanger,
    x: number,
    y: number,
  ): number {
    const base = openPassable(state);
    let n = 0;
    for (const d of DIRECTION_ORDER) {
      const nx = x + dirDX(d);
      const ny = y + dirDY(d);
      if (!inBounds(nx, ny) || !base(nx, ny)) continue;
      const e = danger.earliestLethal(idx(nx, ny));
      if (e === undefined || e > STEP_DANGER_HORIZON) n += 1;
    }
    return n;
  }

  /**
   * enemyPressure(a) — offense term.
   * PLACE_BOMB: value if the cross hits an enemy CURRENT tile; higher when that
   * enemy has FEW non-lethal escapes. Camping: STAY/move ending ADJACENT to a
   * TRAPPED enemy → value for running down its shell. ZERO if the blast would
   * also hit a teammate, or the targeted enemy has a teammate adjacent.
   */
  private enemyPressure(
    state: SimState,
    slot: number,
    myTeam: number,
    cand: Candidate,
    fire: number,
    danger: IntervalDanger,
  ): number {
    if (cand.bomb) {
      const blast = this.blastTiles(state, cand.rx, cand.ry, fire);
      // Never blast a teammate (friendly fire) → zero the term.
      for (const p of state.players) {
        if (p.slot === slot) continue;
        if (p.team !== myTeam || !p.alive || p.trapped) continue;
        if (blast.has(idx(tileOf(p.posX), tileOf(p.posY)))) return 0;
      }
      let best = 0;
      for (const p of state.players) {
        if (p.slot === slot || p.team === myTeam) continue;
        if (!p.alive || p.trapped) continue;
        const ex = tileOf(p.posX);
        const ey = tileOf(p.posY);
        if (!blast.has(idx(ex, ey))) continue;
        // If this foe has a teammate adjacent, an instant re-rescue is likely →
        // not worth it (skip this foe).
        if (this.foeHasAllyAdjacent(state, p.slot, p.team, ex, ey)) continue;
        const escapes = this.safeOpenNeighborCount(state, danger, ex, ey);
        // Fewer escapes ⇒ higher value (5 - escapes, escapes in 0..4).
        const v = 5 - escapes;
        if (v > best) best = v;
      }
      return best;
    }

    // Camping: result tile ADJACENT to a trapped ENEMY → run down its shell.
    let best = 0;
    for (const p of state.players) {
      if (p.slot === slot || p.team === myTeam) continue;
      if (!p.alive || !p.trapped) continue;
      const ex = tileOf(p.posX);
      const ey = tileOf(p.posY);
      const man = Math.abs(ex - cand.rx) + Math.abs(ey - cand.ry);
      if (man <= 1) {
        // Closer to expiry (less shell left) ⇒ more valuable to keep camping.
        const v = 3;
        if (v > best) best = v;
      }
    }
    return best;
  }

  /** True if an alive same-team ally of the foe sits cardinally adjacent. */
  private foeHasAllyAdjacent(
    state: SimState,
    foeSlot: number,
    foeTeam: number,
    ex: number,
    ey: number,
  ): boolean {
    for (const p of state.players) {
      if (p.slot === foeSlot || p.team !== foeTeam) continue;
      if (!p.alive || p.trapped) continue;
      const px = tileOf(p.posX);
      const py = tileOf(p.posY);
      if (Math.abs(px - ex) + Math.abs(py - ey) <= 1) return true;
    }
    return false;
  }

  /**
   * economyValue(a). PLACE_BOMB → soft bricks destroyed. MOVE/STAY → value for
   * stepping toward / onto an item (priority CANNON > FIRE > SPEED), scaled down
   * with BFS distance so nearer items win.
   */
  private economyValue(
    state: SimState,
    cand: Candidate,
    fire: number,
  ): number {
    if (cand.bomb) {
      return this.softDestroyedAt(state, cand.rx, cand.ry, fire);
    }
    if (state.items.length === 0) return 0;
    // Value the best item by PRIORITY discounted by integer Manhattan distance
    // from the result tile (cheap, prng-free, no BFS). Standing on an item tile
    // (distance 0) takes its full priority + the max distance bonus. Iterate
    // items in fixed array order; ties keep the first.
    let best = 0;
    for (const it of state.items) {
      const man = Math.abs(it.tileX - cand.rx) + Math.abs(it.tileY - cand.ry);
      const pri = ITEM_PRIORITY[it.kind] ?? 1;
      const v = pri + Math.max(0, 4 - man);
      if (v > best) best = v;
    }
    return best;
  }

  /**
   * positionValue(a) = open neighbour count of the result tile − Manhattan
   * distance to the map center (CENTER_X, CENTER_Y). Small integer; nudges the
   * bot toward open, central tiles when nothing else discriminates.
   */
  private positionValue(state: SimState, rx: number, ry: number): number {
    const base = openPassable(state);
    let open = 0;
    for (const d of DIRECTION_ORDER) {
      const nx = rx + dirDX(d);
      const ny = ry + dirDY(d);
      if (inBounds(nx, ny) && base(nx, ny)) open += 1;
    }
    const man = Math.abs(rx - CENTER_X) + Math.abs(ry - CENTER_Y);
    return open - man;
  }

  /**
   * aggressionWeight(state) → W_ATTACK. CONTINUOUS integer; phase behaviour
   * emerges from this single weight (no mode switch).
   *
   * EXACT SHIPPED ARITHMETIC (integer math, multiply-before-divide, Math.floor):
   *   softRemaining  = count of TileKind.SOFT in state.map;
   *   softFactor     = clamp(floor((TOTAL_SOFT_REF - softRemaining) * 100
   *                                 / TOTAL_SOFT_REF), 0, 100);   // fewer soft → higher
   *   foeDist        = nearest foe BFS dist over openPassable, capped 40 if none;
   *   proxFactor     = clamp(100 - foeDist * 6, 0, 100);          // closer → higher
   *   raw            = floor(W_ATTACK_BASE * (softFactor + proxFactor + 20) / 100);
   *   aggrScaled     = floor((tuning.aggression ?? 1) * 100);     // e.g. 1.8 → 180
   *   W_ATTACK       = floor(raw * aggrScaled / 100);             // continuous scale
   */
  private aggressionWeight(
    state: SimState,
    slot: number,
    myTeam: number,
    myX: number,
    myY: number,
  ): number {
    let softRemaining = 0;
    for (const t of state.map) {
      if (t === TileKind.SOFT) softRemaining += 1;
    }
    const softFactor = Math.max(
      0,
      Math.min(
        100,
        Math.floor(((TOTAL_SOFT_REF - softRemaining) * 100) / TOTAL_SOFT_REF),
      ),
    );

    const foeTiles = this.foeTiles(state, slot, myTeam);
    let foeDist = 40;
    if (foeTiles.size > 0) {
      const hit = bfsFirstStep(
        state,
        myX,
        myY,
        (x, y) => foeTiles.has(idx(x, y)),
        openPassable(state),
      );
      foeDist = hit === null ? 40 : Math.min(40, hit.dist);
    }
    const proxFactor = Math.max(0, Math.min(100, 100 - foeDist * 6));

    const raw = Math.floor(
      (W_ATTACK_BASE * (softFactor + proxFactor + 20)) / 100,
    );
    const aggrScaled = Math.floor((this.tuning.aggression ?? 1) * 100);
    return Math.floor((raw * aggrScaled) / 100);
  }

  /**
   * PLACE_BOMB HARD SAFETY GATE. Builds the interval danger WITH the hypothetical
   * bomb and requires a reachable refuge tile that stays NON-LETHAL across the
   * whole planning horizon [arrivalTick .. FUSE_TICKS + SPARK_TICKS] AND is
   * reachable in time (escapeFitsInFuse, dist in [1, maxEscapeLen]). Returns the
   * validated refuge [x,y] or null if no safe drop exists.
   */
  private validateBombRefuge(
    state: SimState,
    slot: number,
    myX: number,
    myY: number,
    fire: number,
    ticksPerTile: number,
  ): readonly [number, number] | null {
    const hyp = hypotheticalBomb(myX, myY, fire, slot);
    const dangerWithHyp = buildDangerMap(state, [hyp]);
    const horizonEnd = FUSE_TICKS + SPARK_TICKS;

    // Danger-aware passability: never path through a tile lethal within the near
    // horizon (live flames / imminent fire from OTHER bombs). The new bomb's own
    // arm danger is far off (≈FUSE_TICKS), so those tiles stay walkable.
    const passable = this.dangerAwareInterval(
      state,
      dangerWithHyp,
      STEP_DANGER_HORIZON,
    );

    // BFS over the danger-aware passability; the FIRST goal tile (in BFS order)
    // that stays non-lethal across the whole horizon AND is reachable in time
    // wins. Reuse bfsFirstStep with a goal predicate that also checks the
    // window — but we need the dist, so use a small custom BFS.
    const startIdx = idx(myX, myY);
    const prevDist = new Map<number, number>([[startIdx, 0]]);
    const queue: number[] = [startIdx];
    let cursor = 0;
    while (cursor < queue.length) {
      const cur = queue[cursor];
      cursor += 1;
      if (cur === undefined) continue;
      const cx = cur % MAP_COLS;
      const cy = (cur - cx) / MAP_COLS;
      const dist = prevDist.get(cur) ?? 0;

      if (dist >= 1 && dist <= this.tuning.maxEscapeLen) {
        const arrival = dist * ticksPerTile;
        // Non-lethal across the WHOLE planning window [arrival, horizonEnd]
        // (inclusive end → half-open end+1) AND reachable in time.
        if (
          !dangerWithHyp.lethalBetween(cur, arrival, horizonEnd + 1) &&
          this.escapeFitsInFuse(hyp.fuseTicks, dist, ticksPerTile)
        ) {
          return [cx, cy];
        }
      }

      if (dist >= this.tuning.maxEscapeLen) continue; // don't expand past budget.
      for (const d of DIRECTION_ORDER) {
        const nx = cx + dirDX(d);
        const ny = cy + dirDY(d);
        if (!inBounds(nx, ny)) continue;
        const nIdx = idx(nx, ny);
        if (prevDist.has(nIdx)) continue;
        if (!passable(nx, ny)) continue;
        prevDist.set(nIdx, dist + 1);
        queue.push(nIdx);
      }
    }
    return null;
  }

  /** Score one candidate; fills in score (and refuge for a valid PLACE_BOMB). */
  private scoreCandidate(
    state: SimState,
    slot: number,
    myTeam: number,
    myX: number,
    myY: number,
    cand: Candidate,
    danger: IntervalDanger,
    wAttack: number,
    fire: number,
    ticksPerTile: number,
  ): void {
    const surv = this.survivability(state, danger, cand.rx, cand.ry);
    cand.survSafe = surv > 0;
    const rescue = this.rescueValue(
      state,
      slot,
      myTeam,
      cand.rx,
      cand.ry,
      ticksPerTile,
    );
    const pressure = this.enemyPressure(state, slot, myTeam, cand, fire, danger);
    const econ = this.economyValue(state, cand, fire);
    const pos = this.positionValue(state, cand.rx, cand.ry);

    cand.score =
      W_SURVIVE * surv +
      W_RESCUE * rescue +
      wAttack * pressure +
      W_ECON * econ +
      W_POSITION * pos;
  }

  /** This bot's InputFrame for this tick. MUTATES internal state. */
  sample(state: SimState, slot: number): InputFrame {
    void this.ctorSlot; // ctor slot is debug/seed only; `slot` wins.

    const myPlayer = state.players.find((p) => p.slot === slot);
    if (myPlayer === undefined || !myPlayer.alive || myPlayer.trapped) {
      this.resetActive();
      this.lastTile = -1;
      this.ticksSinceTileChange = 0;
      return NO_INPUT;
    }

    const myX = tileOf(myPlayer.posX);
    const myY = tileOf(myPlayer.posY);
    const myTileIdx = idx(myX, myY);
    const myTeam = myPlayer.team;

    // ---- Stuck detector ----------------------------------------------------
    if (myTileIdx === this.lastTile) {
      this.ticksSinceTileChange += 1;
    } else {
      this.ticksSinceTileChange = 0;
      this.lastTile = myTileIdx;
    }

    // ---- Base danger (interval model) + cheap grid danger for escape path --
    const danger = buildDangerMap(state);
    const gridDanger = predictDanger(state);
    const myDangerEarliest = danger.earliestLethal(myTileIdx);

    // ---- POST-BOMB ESCAPE OVERRIDE (runs FIRST, before scoring) ------------
    const escapeFrame = this.runEscape(state, myX, myY, gridDanger);
    if (escapeFrame !== null) {
      this.threatPending = myDangerEarliest !== undefined;
      this.reactionTimer = 0;
      this.committedDir = Direction.NONE as number;
      this.committedTicks = 0;
      return escapeFrame;
    }

    const tpt = this.ticksPerTile(state, myPlayer.speedBonusTenths);

    // ---- REACTION-DELAY FREEZE (humanizing) --------------------------------
    // A fresh threat to OUR tile, with fire not yet imminent, freezes us for the
    // reaction window — modelling human lag — before the scoring loop reacts.
    const freshThreat =
      myDangerEarliest !== undefined && myDangerEarliest > SURV_REACTION_WINDOW;
    if (freshThreat) {
      if (!this.threatPending) {
        this.reactionTimer = this.tuning.reactionDelayTicks;
        this.threatPending = true;
      }
      if (
        this.reactionTimer > 0 &&
        myDangerEarliest !== undefined &&
        myDangerEarliest > this.reactionTimer + ESCAPE_SAFETY_TICKS
      ) {
        this.reactionTimer -= 1;
        return { dir: Direction.NONE, action: ActionFlags.NONE };
      }
      this.reactionTimer = 0;
    } else {
      this.threatPending = myDangerEarliest !== undefined;
      this.reactionTimer = 0;
    }

    // ---- REPLAN INERTIA ----------------------------------------------------
    // Between decision ticks repeat the committed direction (movement inertia /
    // anti-jitter), but only while it is still safe to step there.
    const safeOpenInterval = this.dangerAwareInterval(
      state,
      danger,
      STEP_DANGER_HORIZON,
    );
    const stuck = this.ticksSinceTileChange >= STUCK_TICKS;
    const committedStillWalkable =
      this.committedDir !== Direction.NONE &&
      this.dirOk(myX, myY, this.committedDir, safeOpenInterval);
    if (stuck) {
      const d = this.randomSafeDir(myX, myY, safeOpenInterval);
      this.commit(d);
      this.ticksSinceTileChange = 0;
      return { dir: d, action: ActionFlags.NONE };
    }
    const decisionTick = this.committedTicks <= 0 || !committedStillWalkable;
    if (!decisionTick) {
      this.committedTicks -= 1;
      return { dir: this.committedDir, action: ActionFlags.NONE };
    }

    // ---- SCORING LOOP ------------------------------------------------------
    const wAttack = this.aggressionWeight(state, slot, myTeam, myX, myY);
    const base = openPassable(state);
    // Move legality = enterable terrain, no bomb, AND not lethal within the near
    // horizon (never step into a live / about-to-ignite melt-flow). Matches the
    // legacy safeOpen gate; the post-bomb escape (runEscape) handles the special
    // case of running down our OWN far-off bomb arm.
    const moveLegal = (x: number, y: number): boolean => {
      if (!inBounds(x, y) || !base(x, y)) return false;
      const e = danger.earliestLethal(idx(x, y));
      return e === undefined || e > STEP_DANGER_HORIZON;
    };

    // FIXED candidate enumeration order: STAY, UP, DOWN, LEFT, RIGHT, PLACE_BOMB.
    const candidates: Candidate[] = [];
    // STAY.
    candidates.push({
      dir: Direction.NONE,
      bomb: false,
      rx: myX,
      ry: myY,
      score: -Infinity,
      survSafe: false,
      refugeX: -1,
      refugeY: -1,
    });
    // Moves in DIRECTION_ORDER.
    for (const d of DIRECTION_ORDER) {
      const nx = myX + dirDX(d);
      const ny = myY + dirDY(d);
      const ok = moveLegal(nx, ny);
      candidates.push({
        dir: d,
        bomb: false,
        rx: ok ? nx : myX,
        ry: ok ? ny : myY,
        score: ok ? -Infinity : Number.NEGATIVE_INFINITY,
        survSafe: false,
        refugeX: -1,
        refugeY: -1,
      });
    }
    // PLACE_BOMB (legal only if cannon free and no bomb on my tile).
    const canBomb =
      myPlayer.activeBombs < myPlayer.cannon &&
      bombAt(state.bombs, myX, myY) === undefined;
    const bombCand: Candidate = {
      dir: Direction.NONE,
      bomb: true,
      rx: myX,
      ry: myY,
      score: -Infinity,
      survSafe: false,
      refugeX: -1,
      refugeY: -1,
    };
    candidates.push(bombCand);

    // Score each candidate. Illegal moves keep -Infinity.
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (c === undefined) continue;
      if (c.bomb) {
        if (!canBomb) {
          c.score = Number.NEGATIVE_INFINITY;
          continue;
        }
        // HARD SAFETY GATE FIRST.
        const refuge = this.validateBombRefuge(
          state,
          slot,
          myX,
          myY,
          myPlayer.fire,
          tpt,
        );
        if (refuge === null) {
          c.score = Number.NEGATIVE_INFINITY;
          continue;
        }
        c.refugeX = refuge[0];
        c.refugeY = refuge[1];
        this.scoreCandidate(
          state,
          slot,
          myTeam,
          myX,
          myY,
          c,
          danger,
          wAttack,
          myPlayer.fire,
          tpt,
        );
      } else {
        // STAY is always legal (rx,ry = current tile). A move into a blocked or
        // soon-lethal tile is illegal → -Infinity.
        const isBlockedMove =
          c.dir !== Direction.NONE &&
          !moveLegal(myX + dirDX(c.dir), myY + dirDY(c.dir));
        if (isBlockedMove) {
          c.score = Number.NEGATIVE_INFINITY;
          continue;
        }
        this.scoreCandidate(
          state,
          slot,
          myTeam,
          myX,
          myY,
          c,
          danger,
          wAttack,
          myPlayer.fire,
          tpt,
        );
      }
    }

    // ---- PICK (fixed order, strict `>` — first candidate wins ties) --------
    // bestI = overall best legal candidate. secondI = best SURVIVABILITY-SAFE
    // candidate other than bestI: a mistake may fall back to it, but NEVER to a
    // candidate whose result tile is lethal within the reaction window (walking
    // into a live melt-flow). PLACE_BOMB commits to a validated refuge, so it
    // counts as survivability-safe when the gate passed.
    let bestI = -1;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (c === undefined || c.score === Number.NEGATIVE_INFINITY) continue;
      if (bestI < 0) {
        bestI = i;
        continue;
      }
      const best = candidates[bestI];
      if (best !== undefined && c.score > best.score) bestI = i;
    }
    // Best survivability-safe runner-up (fixed order, strict `>`, first wins).
    let secondI = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (i === bestI) continue;
      const c = candidates[i];
      if (c === undefined || c.score === Number.NEGATIVE_INFINITY) continue;
      const eligible = c.bomb ? true : c.survSafe;
      if (!eligible) continue;
      if (secondI < 0) {
        secondI = i;
        continue;
      }
      const cur = candidates[secondI];
      if (cur !== undefined && c.score > cur.score) secondI = i;
    }

    // ---- MISTAKE ------------------------------------------------------------
    // One randFloat per decision. On a mistake, take the SECOND-best (survivable)
    // candidate (never disables the gate, never steps into fire). easy-only
    // reckless: with prob recklessBombChance, allow a reckless PLACE_BOMB that
    // relaxes the timing gate (best-effort refuge). normal/hard reckless = 0.
    let chosen = bestI;
    if (bestI >= 0 && this.randFloat() < this.tuning.mistakeChance) {
      // Reckless drop is only attempted when the spot would actually HIT A FOE
      // (offense), never a gratuitous self-bomb while farming soft bricks —
      // mirroring the legacy reckless precondition (combat-only). This keeps the
      // easy bot's deliberate self-bombs to roughly the legacy frequency.
      const worthDrop =
        this.enemyPressure(
          state,
          slot,
          myTeam,
          bombCand,
          myPlayer.fire,
          danger,
        ) > 0;
      if (
        this.tuning.recklessBombChance > 0 &&
        this.randFloat() < this.tuning.recklessBombChance &&
        canBomb &&
        worthDrop &&
        bombCand.score === Number.NEGATIVE_INFINITY
      ) {
        // Reckless drop: relax the timing gate to a best-effort refuge.
        const safe = findNearestSafe(state, myX, myY, gridDanger);
        if (safe !== null) {
          bombCand.refugeX = safe[0];
          bombCand.refugeY = safe[1];
          chosen = candidates.indexOf(bombCand);
        }
      } else if (secondI >= 0) {
        chosen = secondI;
      }
    }

    const winner = chosen >= 0 ? candidates[chosen] : undefined;

    // ---- SURVIVAL-FIRST SAFETY NET -----------------------------------------
    // If our CURRENT tile will ignite within the FLEE HORIZON — sized so we have
    // the lead time to clear a full maxEscapeLen route at our current speed —
    // override the scoring winner and RUN, before the pocket closes. (The flee
    // horizon, not just the reaction window, is what stops the bot from sitting
    // on / wandering back onto its OWN bomb's arm until it is boxed in: it bails
    // out while an exit still exists.) Flee to the nearest TRULY-safe tile via a
    // danger-aware BFS (interval model); if none is reachable, step toward the
    // open neighbour with the LATEST fire (and NEVER onto a tile burning now).
    // This is the legacy "survival first" behaviour, kept as a hard net so the
    // scoring loop can never trade survival for tempo.
    const fleeHorizon = Math.max(
      SURV_REACTION_WINDOW,
      this.tuning.maxEscapeLen * tpt +
        this.tuning.reactionDelayTicks +
        TRAVEL_SLACK_TICKS,
    );
    if (myDangerEarliest !== undefined && myDangerEarliest <= fleeHorizon) {
      const fleeSafe = this.dangerAwareInterval(
        state,
        danger,
        STEP_DANGER_HORIZON,
      );
      const hit = bfsFirstStep(
        state,
        myX,
        myY,
        (x, y) => {
          const e = danger.earliestLethal(idx(x, y));
          return e === undefined || e > SURV_SAFE_HORIZON;
        },
        fleeSafe,
      );
      if (hit !== null && hit.firstDir !== Direction.NONE) {
        this.commit(hit.firstDir);
        return { dir: hit.firstDir, action: ActionFlags.NONE };
      }
      // No reachable refuge: buy time by stepping toward the latest-igniting
      // open neighbour that is NOT on fire right now (earliest > 0).
      let bestDir = Direction.NONE as number;
      let bestTicks = -1;
      const baseOpen = openPassable(state);
      for (const d of DIRECTION_ORDER) {
        const nx = myX + dirDX(d);
        const ny = myY + dirDY(d);
        if (!inBounds(nx, ny) || !baseOpen(nx, ny)) continue;
        const e = danger.earliestLethal(idx(nx, ny));
        if (e !== undefined && e <= 0) continue; // never step onto live fire.
        const ticks = e === undefined ? Number.MAX_SAFE_INTEGER : e;
        if (ticks > bestTicks) {
          bestTicks = ticks;
          bestDir = d;
        }
      }
      this.commit(bestDir);
      return { dir: bestDir, action: ActionFlags.NONE };
    }

    if (winner === undefined) {
      // No legal candidate (boxed in) → hold still on our currently-safe tile.
      this.commit(Direction.NONE as number);
      return { dir: Direction.NONE, action: ActionFlags.NONE };
    }

    if (winner.bomb) {
      // Rising edge: drop and COMMIT to the validated refuge.
      this.committedDir = Direction.NONE as number;
      this.committedTicks = 0;
      this.escapeTargetX = winner.refugeX;
      this.escapeTargetY = winner.refugeY;
      this.escapeTicks = 0;
      return { dir: Direction.NONE, action: ActionFlags.BOMB };
    }

    // Move / STAY → commit the direction for replan inertia.
    this.commit(winner.dir);
    return { dir: winner.dir, action: ActionFlags.NONE };
  }
}
