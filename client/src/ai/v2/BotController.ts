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
 * - NONE of the determinism-hostile globals (wall-clock now(), nondeterministic
 *   random(), or the irrational Math helpers sqrt/sin/cos).
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
import type { BombState } from '../../sim/Bomb';
import {
  FUSE_TICKS,
  MAP_COLS,
  MAP_ROWS,
  MILLITILE,
  PLAYER_MAX_CANNON,
  PLAYER_MAX_FIRE,
  PLAYER_START_CANNON,
  PLAYER_START_FIRE,
  SPARK_TICKS,
} from '../../../../shared/constants';
import { ActionFlags, Direction, ItemKind, TileKind } from '../../../../shared/types';
import type { BotTuning } from './BotConfig';
import { botRandFloat, botRandInt } from './BotConfig';
import {
  type DangerMap,
  type Passable,
  bfsFirstStep,
  bfsReachable,
  dangerAwarePassable,
  findNearestSafe,
  hypotheticalBomb,
  isSafeTile,
  openPassable,
  predictDanger,
  tileDangerTicks,
} from '../common/grid';
import { type IntervalDanger, buildDangerMap } from '../common/dangerMap';
import {
  ANTI_BACKTRACK_PENALTY,
  COMMIT_HYSTERESIS,
  FARM_HOLD_TICKS,
  FIGHT_HOLD_TICKS,
  GoalCommitment,
} from './commitment';
import { MAX_SCENARIO_ENEMIES, buildScenarios } from './scenarios';
import {
  type SearchState,
  RootAction,
  forwardSearch,
} from './forwardSearch';

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
/**
 * (A) Growth-pull weight — a SEPARATE small term, deliberately NOT folded into
 * W_ECON's 20× multiplier. The pull is a monotonic navigation gradient (see
 * growthValue / GROWTH_REACH_SPAN): the advancing MOVE toward the nearest
 * reachable soft-brick / power-up target earns
 *   W_GROWTH * floor((GROWTH_REACH_SPAN - growthDist) * devFactor / 100),
 * every non-advancing candidate earns 0. So the advancing move enjoys that
 * whole amount as an ADVANTAGE over its rivals, and every step that REDUCES the
 * BFS hop distance scores strictly higher — the bot homes in on growth targets
 * (re)planned each decision tick, all across the arena, not just one hop away.
 *
 * Sizing (W_GROWTH = 3, GROWTH_REACH_SPAN = 10):
 *  - The pull is gated to ONLY fire when there is NOTHING worth bombing on the
 *    current tile (GROWTH_FILL_THRESHOLD = 1 → suppressed if even ONE in-place
 *    brick is breakable here). So it never competes with — let alone overrides
 *    — a productive in-place bomb; it only replaces aimless wandering.
 *  - In that wander gap it must beat the W_POSITION center-drift spread
 *    (per-candidate swing ≤ ~6 * W_POSITION = 18). At full devFactor a target
 *    one hop away gives 3*floor((10-1)*100/100) = 27 > 18, and the advantage
 *    decays gently with distance (dist 5 → 15, dist 9 → 3) so a far target
 *    still nudges without yanking the bot off productive in-place bombing the
 *    instant a brick appears beside it.
 *  - Max pull = 3*(SPAN-1) = 27 ≪ W_SURVIVE (1000) and below one unit of a
 *    moderate attack term, so survivability and genuine attack pressure always
 *    win — the pull merely fills the "go find the next bricks" gap.
 *
 * (Earlier this was a range-1, ≤2-pt nudge that died the moment the bricks
 * adjacent to spawn were cleared, so the bot stalled and drifted to center
 * instead of crossing to fresh clusters; a too-strong full-map version
 * (SPAN 32 / W_GROWTH 8, gate 2) over-corrected and pulled the bot off in-place
 * bombing, halving its development — the behavioral probe drove these numbers.)
 */
const W_GROWTH = 3;

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

// ---------------------------------------------------------------------------
// GROWTH DRIVE (fix for "stops farming bricks/items too early").
//
// Two nudges (candidate order + tie-break untouched):
//
//  (A) Positional pull (its OWN small W_GROWTH term, NOT folded into W_ECON):
//      a single BFS reachable map (per bot-tile) finds the nearest QUALIFYING
//      soft-brick farm tile and the nearest power-up item tile by hop distance.
//      The MOVE candidate whose dir == the chosen target's first-step direction
//      gets a monotonic navigation gradient: bonus = max(0, GROWTH_REACH_SPAN -
//      growthDist), so every step that reduces the BFS hop distance to the
//      target scores strictly higher. Because bfsReachable is uncapped (whole
//      15x13 arena) the target can be anywhere reachable, and because the
//      gradient is re-planned each decision tick the bot keeps homing in on the
//      next cluster across the map — it no longer stalls once the bricks beside
//      spawn are gone. Because it is a SEPARATE small term (W_GROWTH ≪ W_ECON)
//      and is suppressed whenever ANY in-place bomb is productive
//      (GROWTH_FILL_THRESHOLD = 1), it can never outrank — or even compete with
//      — productive in-place bombing; it only fills the "nothing to bomb here,
//      go find the next bricks" gap. (Originally a range-1 ≤2-pt nudge that died
//      once spawn-adjacent bricks were cleared, leaving the bot drifting to
//      center; a too-strong full-map version then over-corrected and pulled the
//      bot off in-place bombing, halving development — the behavioral probe
//      drove SPAN=10 / W_GROWTH=3 / gate=1; and earlier still it was folded into
//      W_ECON, where the 20× let a +1 gradient beat in-place bombing.)
//
//  (B) Readiness model + close-quarters engage override: the grow-vs-fight
//      choice is governed by combat-readiness of OWN stats (developmentFactor).
//      While fire+cannon are below a mid target the economy contribution is
//      scaled UP, the attack weight scaled DOWN, and the growth pull (A) active
//      (all smooth integer ramps), so growth competes with attack until the bot
//      is developed; once grown, behaviour returns to attack-dominant. Relative/
//      additive on top of the archetype's aggression — Turtle stays passive,
//      Aggressor stays aggressive.
//
//      ON TOP of readiness, a close-quarters OVERRIDE: when the nearest
//      attackable foe is within COMBAT_ENGAGE_DIST hops, the bot uses an
//      EFFECTIVE readiness of 0 (effDevFactor in sample()) for ALL THREE
//      scalings THIS tick — growth pull suppressed, econ-up cancelled, attack at
//      full strength — so it stops farming and fights immediately even when
//      still under-developed. No foe nearby + under-developed → grow (unchanged);
//      foe within engage dist → drop farming and fight; developed → attack-
//      dominant as before. Survival stays dominant: the override never disables
//      the bomb-refuge gate or the survival-first safety net (W_SURVIVE).
// ---------------------------------------------------------------------------

/**
 * Span of the positional growth gradient (A). The advancing MOVE toward the
 * nearest growth target scores bonus = max(0, GROWTH_REACH_SPAN - growthDist):
 * biggest for an adjacent target (dist 1 → SPAN-1 = 9) and strictly decreasing
 * with hop distance, reaching 0 at SPAN hops. Every step that reduces the BFS
 * hop distance scores strictly higher, so the bot homes in on a target wherever
 * it is — the gradient is re-planned each decision tick, so a target farther
 * than SPAN still gets pursued (its bonus rises as the bot closes in). 10 is the
 * sweet spot the behavioral probe found: large enough to navigate to the next
 * cluster (≫ the small W_POSITION center-drift spread) yet gentle enough that
 * the pull never yanks the bot off productive in-place bombing once a brick
 * appears beside it (a much larger span over-corrected and halved development).
 * Integer; scaled by devFactor and carried by the separate small W_GROWTH term
 * so it never overpowers survivability / attack / econ (max W_GROWTH*(SPAN-1) =
 * 27 ≪ W_SURVIVE = 1000).
 */
const GROWTH_REACH_SPAN = 10;

/**
 * (A) "Fill the gap" gate: the growth pull is suppressed when ANY productive
 * in-place bomb (≥ this many soft bricks breakable from the bot's CURRENT tile)
 * is available — so the navigation pull never competes with bombing the bricks
 * right here. The pull fires ONLY when the bot has nothing worth bombing on its
 * tile, filling the "nothing to do here, go find the next bricks" gap. The
 * behavioral probe was decisive: at threshold 2 the (now stronger) pull beat a
 * single-brick in-place bomb and the bot kept walking past lone bricks chasing
 * distant targets, HALVING its development; lowering to 1 restored steady,
 * sustained farming (and on pirate roughly +50% bricks over the old range-1
 * nudge, no longer plateauing after the opening) while keeping in-place bombing
 * strictly prioritised.
 */
const GROWTH_FILL_THRESHOLD = 1;

/**
 * Under-development boost (B). Mid-development target the bot ramps toward:
 * fire ~ DEV_TARGET_FIRE, cannon ~ DEV_TARGET_CANNON. Below this the economy
 * is scaled up and attack scaled down (linear, integer); at/above it the boost
 * is 0 and behaviour is unchanged. Targets sit mid-way between start and max.
 */
// Midpoints between start and max (integer floor); the bot ramps toward these.
const DEV_TARGET_FIRE = Math.floor((PLAYER_START_FIRE + PLAYER_MAX_FIRE) / 2); // 4
const DEV_TARGET_CANNON = Math.floor(
  (PLAYER_START_CANNON + PLAYER_MAX_CANNON) / 2,
); // 3
/**
 * Max extra economy multiplier (percent) when fully under-developed: effective
 * econ = floor(econ * (100 + boost) / 100), boost in [0, DEV_ECON_BOOST_MAX].
 */
const DEV_ECON_BOOST_MAX = 100; // up to 2× economy when freshly spawned.
/**
 * Max attack-weight reduction (percent) when fully under-developed: effective
 * wAttack = floor(wAttack * (100 - cut) / 100), cut in [0, DEV_ATTACK_CUT_MAX].
 * Kept well below 100 so an aggressive archetype still attacks meaningfully.
 */
const DEV_ATTACK_CUT_MAX = 20;

/**
 * Close-quarters combat-engage threshold (BFS hops). The grow-vs-fight choice
 * is normally governed by OWN-stat readiness (developmentFactor): an
 * under-developed bot farms, a developed bot fights. This const adds an
 * OVERRIDE on top of that model — when the nearest attackable foe is within
 * COMBAT_ENGAGE_DIST hops, the bot drops farming and fights at FULL strength
 * THIS tick even if still under-developed (see effDevFactor in sample()).
 * Small (3) so it only fires at genuine close quarters, where standing around
 * farming next to a foe is a liability; it never disables the survival-first
 * safety net or the bomb-refuge gate. Tunable via the behavioral probe.
 */
const COMBAT_ENGAGE_DIST = 3;

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

  /**
   * v2 goal-commitment hysteresis (anti-dither). NOT a mode FSM — it only feeds
   * an integer anti-backtrack penalty into the forward-search leaf evaluation.
   */
  private readonly goal = new GoalCommitment();

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

  /**
   * HARD friendly-fire gate. True if a bomb placed at (rx,ry) with reach `fire`
   * would cover the CURRENT tile of any OTHER live, non-trapped same-team player.
   * Reuses blastTiles (the SAME cross geometry enemyPressure uses) so the test is
   * identical to the existing friendly-fire check — just promoted to a candidate-
   * level gate that applies regardless of why the bomb is being placed (attack,
   * econ, or growth). In FFA every player is on their own team, so there is no
   * other same-team player and this always returns false (gate never fires).
   */
  private bombHitsTeammate(
    state: SimState,
    slot: number,
    myTeam: number,
    rx: number,
    ry: number,
    fire: number,
  ): boolean {
    const blast = this.blastTiles(state, rx, ry, fire);
    for (const p of state.players) {
      if (p.slot === slot) continue;
      if (p.team !== myTeam || !p.alive || p.trapped) continue;
      if (blast.has(idx(tileOf(p.posX), tileOf(p.posY)))) return true;
    }
    return false;
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
   * with BFS distance so nearer items win. The cross-map positional growth pull
   * (A) lives in its OWN term (growthValue / W_GROWTH), NOT here.
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
   * (A) Positional growth pull as a SEPARATE small term (NOT scaled by W_ECON's
   * 20×). Only the advancing MOVE (dir == growthFirstDir) toward the nearest
   * growth target earns it; every other candidate earns 0, so the advancing
   * move enjoys the whole returned amount as an ADVANTAGE over its rivals.
   *
   * Monotonic navigation gradient (not a range-1 nudge):
   *   bonus = max(0, GROWTH_REACH_SPAN - growthDist)
   * with growthDist the chosen target's BFS hop distance (from an uncapped,
   * whole-arena BFS). bonus is biggest for an adjacent target and strictly
   * decreasing in growthDist, so every step that REDUCES the hop distance scores
   * higher — re-planned each decision tick, the bot homes in on the next cluster
   * anywhere on the map instead of stalling once spawn-adjacent bricks are gone.
   * Scaled by devFactor via integer math (multiply-before-divide, floor) so the
   * pull stays effective across the whole under-developed phase (e.g. devFactor
   * 50 after 1-2 upgrades) and fades to 0 once developed. Returns a bounded
   * integer the caller multiplies by W_GROWTH; max W_GROWTH*(SPAN-1) = 27 ≪
   * W_SURVIVE = 1000.
   *
   * Gated two ways so it only HELPS (never competes with in-place bombing):
   *  - devFactor: fades to 0 once the bot is developed (a grown bot keeps the
   *    unchanged attack-dominant behaviour);
   *  - "fill the gap": suppressed whenever ANY in-place bomb is productive
   *    (`inPlaceBricks >= GROWTH_FILL_THRESHOLD`, threshold 1) — bombing the
   *    bricks on the current tile is always preferred over moving toward a
   *    distant target. The pull fires ONLY when there is nothing worth bombing
   *    here, so it just replaces aimless wandering.
   *
   * `inPlaceBricks` = soft bricks a bomb dropped on the bot's CURRENT tile would
   * break right now.
   */
  private growthValue(
    cand: Candidate,
    growthFirstDir: number,
    growthDist: number,
    devFactor: number,
    inPlaceBricks: number,
  ): number {
    if (cand.bomb) return 0;
    if (
      devFactor <= 0 ||
      growthFirstDir === Direction.NONE ||
      cand.dir !== growthFirstDir ||
      growthDist <= 0
    ) {
      return 0;
    }
    // Fill-the-gap gate: don't pull the bot away from ANY productive in-place
    // bomb (threshold 1) — bombing the bricks here always wins over navigating.
    if (inPlaceBricks >= GROWTH_FILL_THRESHOLD) return 0;
    // Monotonic gradient: closer target → strictly higher bonus, 0 at SPAN hops.
    const reachBonus = Math.max(0, GROWTH_REACH_SPAN - growthDist);
    return Math.floor((reachBonus * devFactor) / 100);
  }

  /**
   * Under-development factor (B), integer 0..100. 100 = freshly spawned (fire =
   * PLAYER_START_FIRE, cannon = PLAYER_START_CANNON), 0 = at/above the mid
   * development target (DEV_TARGET_FIRE / DEV_TARGET_CANNON). Linear ramp on the
   * combined fire+cannon progress toward the target — NOT a hard cliff. Used to
   * scale economy UP and attack DOWN while under-developed.
   */
  private developmentFactor(fire: number, cannon: number): number {
    // Progress, in "upgrade points", from spawn toward the mid target.
    const targetSpan =
      DEV_TARGET_FIRE -
      PLAYER_START_FIRE +
      (DEV_TARGET_CANNON - PLAYER_START_CANNON);
    if (targetSpan <= 0) return 0;
    const got =
      Math.max(0, Math.min(DEV_TARGET_FIRE, fire) - PLAYER_START_FIRE) +
      Math.max(0, Math.min(DEV_TARGET_CANNON, cannon) - PLAYER_START_CANNON);
    // 100 when got = 0 (just spawned), 0 when got >= targetSpan (developed).
    return Math.max(0, Math.min(100, 100 - Math.floor((got * 100) / targetSpan)));
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
   * The nearest-foe BFS distance is computed ONCE per sample() (see the SCORING
   * LOOP section) and passed in as `foeDist` (capped 40, 40 when no foe), so the
   * same value also feeds the close-quarters engage override. `devFactor` here
   * is the EFFECTIVE readiness (effDevFactor): equal to the real readiness while
   * no foe is engaged, but forced to 0 when a foe is within COMBAT_ENGAGE_DIST
   * so the under-developed attack `cut` is cancelled (full aggression at close
   * quarters). Only the `cut` derives from this effective value; the base/raw
   * aggression arithmetic (softFactor, proxFactor, raw, aggrScaled, scaled) is
   * unchanged, and proxFactor already independently raises attack as a foe nears.
   *
   * EXACT SHIPPED ARITHMETIC (integer math, multiply-before-divide, Math.floor):
   *   softRemaining  = count of TileKind.SOFT in state.map;
   *   softFactor     = clamp(floor((TOTAL_SOFT_REF - softRemaining) * 100
   *                                 / TOTAL_SOFT_REF), 0, 100);   // fewer soft → higher
   *   foeDist        = nearest foe BFS dist over openPassable, capped 40 if none (passed in);
   *   proxFactor     = clamp(100 - foeDist * 6, 0, 100);          // closer → higher
   *   raw            = floor(W_ATTACK_BASE * (softFactor + proxFactor + 20) / 100);
   *   aggrScaled     = floor((tuning.aggression ?? 1) * 100);     // e.g. 1.8 → 180
   *   W_ATTACK       = floor(raw * aggrScaled / 100);             // continuous scale
   */
  private aggressionWeight(
    state: SimState,
    foeDist: number,
    devFactor: number,
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

    const proxFactor = Math.max(0, Math.min(100, 100 - foeDist * 6));

    const raw = Math.floor(
      (W_ATTACK_BASE * (softFactor + proxFactor + 20)) / 100,
    );
    const aggrScaled = Math.floor((this.tuning.aggression ?? 1) * 100);
    const scaled = Math.floor((raw * aggrScaled) / 100);
    // (B) While under-developed, reduce attack so growth competes with it. The
    // cut is RELATIVE (a percentage of this archetype's own attack weight), so
    // a Turtle stays passive and an Aggressor stays comparatively aggressive —
    // the cut never flattens archetype differences. devFactor 100 → full cut,
    // 0 → no cut. Returns to the unchanged attack weight once developed. Because
    // the caller passes the EFFECTIVE readiness, a foe within COMBAT_ENGAGE_DIST
    // sets devFactor 0 here → no cut → full aggression at close quarters.
    const cut = Math.floor((DEV_ATTACK_CUT_MAX * devFactor) / 100);
    return Math.floor((scaled * (100 - cut)) / 100);
  }

  /**
   * PESSIMISTIC PLACE_BOMB gate (v2). Builds the danger map with OUR hypothetical
   * bomb PLUS the nearest live enemies' hypothetical bombs (same cap/selection as
   * buildScenarios — up to MAX_SCENARIO_ENEMIES nearest within foeReachTiles BFS
   * hops, cannon>0), then runs the SAME BFS-refuge logic v1's validateBombRefuge
   * used, but against this worst-case danger. When NO enemy is nearby, enemyHyps
   * is empty and this is byte-identical to the v1 gate (no open-map regression).
   * Returns the validated refuge [x,y] or null.
   */
  private validateBombRefugePessimistic(
    state: SimState,
    slot: number,
    myTeam: number,
    myX: number,
    myY: number,
    fire: number,
    ticksPerTile: number,
    foeReachTiles: number,
  ): readonly [number, number] | null {
    const hyp = hypotheticalBomb(myX, myY, fire, slot);
    const enemyHyps = this.nearestEnemyHyps(
      state,
      slot,
      myTeam,
      myX,
      myY,
      foeReachTiles,
    );
    const dangerPessimistic = buildDangerMap(state, [hyp, ...enemyHyps]);
    const horizonEnd = FUSE_TICKS + SPARK_TICKS;

    const passable = this.dangerAwareInterval(
      state,
      dangerPessimistic,
      STEP_DANGER_HORIZON,
    );

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
        if (
          !dangerPessimistic.lethalBetween(cur, arrival, horizonEnd + 1) &&
          this.escapeFitsInFuse(hyp.fuseTicks, dist, ticksPerTile)
        ) {
          return [cx, cy];
        }
      }

      if (dist >= this.tuning.maxEscapeLen) continue;
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

  /**
   * Combined PLACE_BOMB gate used by the forward search: friendly-fire gate
   * (never blast a teammate) AND the pessimistic refuge gate (a survivable
   * refuge exists vs our bomb + nearby enemy pressure). Pure for fixed `state`.
   */
  private computeBombGateOk(
    state: SimState,
    slot: number,
    myTeam: number,
    bx: number,
    by: number,
    fire: number,
    ticksPerTile: number,
    foeReachTiles: number,
  ): boolean {
    if (this.bombHitsTeammate(state, slot, myTeam, bx, by, fire)) return false;
    return (
      this.validateBombRefugePessimistic(
        state,
        slot,
        myTeam,
        bx,
        by,
        fire,
        ticksPerTile,
        foeReachTiles,
      ) !== null
    );
  }

  /**
   * Hypothetical bombs for the up-to-MAX_SCENARIO_ENEMIES nearest ATTACKABLE
   * enemies (different team, alive, not trapped, different slot, cannon>0) within
   * `foeReachTiles` BFS hops over openPassable. Same selection/ordering as
   * scenarios.ts so the pessimistic gate and scenario[1] agree. Deterministic
   * (sorted by BFS hop dist, tie-break by player array order). No RNG.
   */
  private nearestEnemyHyps(
    state: SimState,
    slot: number,
    myTeam: number,
    myX: number,
    myY: number,
    foeReachTiles: number,
  ): BombState[] {
    const reach = bfsReachable(state, myX, myY, openPassable(state));
    const cands: Array<{ order: number; dist: number; bomb: BombState }> = [];
    let order = 0;
    for (const p of state.players) {
      const myOrder = order;
      order += 1;
      if (p.slot === slot || !p.alive || p.trapped) continue;
      if (p.team === myTeam) continue;
      if (p.cannon <= 0) continue;
      const ex = tileOf(p.posX);
      const ey = tileOf(p.posY);
      const info = reach.get(idx(ex, ey));
      if (info === undefined || info.dist > foeReachTiles) continue;
      cands.push({
        order: myOrder,
        dist: info.dist,
        bomb: hypotheticalBomb(ex, ey, p.fire, p.slot),
      });
    }
    cands.sort((a, b) =>
      a.dist !== b.dist ? a.dist - b.dist : a.order - b.order,
    );
    return cands.slice(0, MAX_SCENARIO_ENEMIES).map((c) => c.bomb);
  }

  /**
   * v2 optimistic leaf reward (against scenario[0]). Sums the SAME v1 reward
   * terms — rescue, enemyPressure, economy, growth, position — using the v1
   * formulas (via a synthesised Candidate so the term helpers are reused
   * verbatim), scaled by the same wAttack. Survivability is handled separately by
   * the maximin aggregation, so it is NOT included here. Integer throughout.
   */
  private leafReward(
    state: SimState,
    slot: number,
    myTeam: number,
    myX: number,
    myY: number,
    rx: number,
    ry: number,
    bombHere: boolean,
    fire: number,
    danger: IntervalDanger,
    wAttack: number,
    ticksPerTile: number,
    growthFirstDir: number,
    growthDist: number,
    effDevFactor: number,
    inPlaceBricks: number,
  ): number {
    // Synthesize the candidate the v1 term helpers expect. For a bomb leaf the
    // result tile == current tile (bomb drops in place). For a move/stay leaf the
    // dir is irrelevant to every term EXCEPT growthValue, which keys off
    // dir === growthFirstDir. The growth pull should fire for a leaf that
    // ADVANCED one step toward the growth target — i.e. its result tile is the
    // neighbour of (myX,myY) in growthFirstDir — exactly like v1's MOVE
    // candidate. Derive that deterministically from the result tile.
    let leafDir = Direction.NONE as number;
    if (
      !bombHere &&
      growthFirstDir !== Direction.NONE &&
      rx === myX + dirDX(growthFirstDir) &&
      ry === myY + dirDY(growthFirstDir)
    ) {
      leafDir = growthFirstDir;
    }
    const cand: Candidate = {
      dir: leafDir,
      bomb: bombHere,
      rx,
      ry,
      score: 0,
      survSafe: true,
      refugeX: -1,
      refugeY: -1,
    };
    const rescue = this.rescueValue(state, slot, myTeam, rx, ry, ticksPerTile);
    const pressure = this.enemyPressure(state, slot, myTeam, cand, fire, danger);
    const econRaw = this.economyValue(state, cand, fire);
    const growth = this.growthValue(
      cand,
      growthFirstDir,
      growthDist,
      effDevFactor,
      inPlaceBricks,
    );
    const econBoost = Math.floor((DEV_ECON_BOOST_MAX * effDevFactor) / 100);
    const econ = Math.floor((econRaw * (100 + econBoost)) / 100);
    const pos = this.positionValue(state, rx, ry);
    return (
      W_RESCUE * rescue +
      wAttack * pressure +
      W_ECON * econ +
      W_GROWTH * growth +
      W_POSITION * pos
    );
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
    // (B) Under-development factor: drives the economy boost, attack cut, and
    // growth pull so growth competes with attack until the bot is developed.
    const devFactor = this.developmentFactor(myPlayer.fire, myPlayer.cannon);

    // Nearest attackable-foe BFS distance over open passability, computed ONCE
    // here (capped 40, 40 when no foe). It feeds BOTH the close-quarters engage
    // override below AND aggressionWeight's proxFactor (passed in), so the two
    // stay in sync. Logic is byte-identical to the version formerly inside
    // aggressionWeight (same foeTiles, same bfsFirstStep, same cap 40).
    const foeTilesNow = this.foeTiles(state, slot, myTeam);
    let foeDist = 40;
    if (foeTilesNow.size > 0) {
      const foeHit = bfsFirstStep(
        state,
        myX,
        myY,
        (x, y) => foeTilesNow.has(idx(x, y)),
        openPassable(state),
      );
      foeDist = foeHit === null ? 40 : Math.min(40, foeHit.dist);
    }

    // CLOSE-QUARTERS ENGAGE OVERRIDE. The grow-vs-fight choice is normally
    // governed by readiness (devFactor). When a foe is within engage distance,
    // treat the bot as FULLY developed (effDevFactor → 0) for THIS tick's three
    // readiness scalings — growth pull suppressed (growthValue returns 0 for
    // devFactor<=0), econ-up cancelled (econBoost = 0), and the under-developed
    // attack cut cancelled (full aggression) — so an under-developed bot drops
    // farming and fights the close foe instead of wandering off to bricks. With
    // no foe nearby it stays the real readiness (grow as before). Survival is
    // untouched: this only re-weights grow-vs-fight, never the safety gates.
    const foeEngaged = foeDist <= COMBAT_ENGAGE_DIST;
    const effDevFactor = foeEngaged ? 0 : devFactor;

    // (A) Positional growth pull: ONE BFS reachable map over open passability
    // gives every reachable tile's hop distance + first-step direction. From it
    // pick the nearest QUALIFYING soft-brick farm tile (adjacent to a soft brick
    // AND a bomb there would actually break one) and the nearest power-up item
    // tile, then pull toward the NEARER of the two (tie → item wins). The chosen
    // target's firstDir/dist feeds growthValue (the separate W_GROWTH term).
    const reachable = bfsReachable(state, myX, myY, openPassable(state));
    let farmDist = Number.MAX_SAFE_INTEGER;
    let farmDir = Direction.NONE as number;
    // Fixed iteration order = BFS insertion order (deterministic); first wins.
    for (const [tIdx, info] of reachable) {
      if (info.dist === 0) continue; // our own tile is no "advancing" target.
      const tx = tIdx % MAP_COLS;
      const ty = (tIdx - tx) / MAP_COLS;
      if (this.softDestroyedAt(state, tx, ty, myPlayer.fire) <= 0) continue;
      if (info.dist < farmDist) {
        farmDist = info.dist;
        farmDir = info.firstDir;
      }
    }
    let itemDist = Number.MAX_SAFE_INTEGER;
    let itemDir = Direction.NONE as number;
    // Iterate items in fixed array order; first (nearest) wins ties.
    for (const it of state.items) {
      const info = reachable.get(idx(it.tileX, it.tileY));
      if (info === undefined || info.dist === 0) continue;
      if (info.dist < itemDist) {
        itemDist = info.dist;
        itemDir = info.firstDir;
      }
    }
    // Soft bricks a bomb dropped on the bot's CURRENT tile would break right now
    // (used by 'fill' mode to suppress the movement pull when productive bombing
    // is already available here).
    const inPlaceBricks = this.softDestroyedAt(state, myX, myY, myPlayer.fire);
    // Prefer the NEARER target; on a tie the item wins (documented rule).
    let growthFirstDir = Direction.NONE as number;
    let growthDist = 0;
    if (itemDist <= farmDist && itemDist !== Number.MAX_SAFE_INTEGER) {
      growthFirstDir = itemDir;
      growthDist = itemDist;
    } else if (farmDist !== Number.MAX_SAFE_INTEGER) {
      growthFirstDir = farmDir;
      growthDist = farmDist;
    }

    const wAttack = this.aggressionWeight(state, foeDist, effDevFactor);
    const foeReachTiles = this.tuning.combatRangeTiles ?? 5;

    // ---- SURVIVAL-FIRST SAFETY NET (fires FIRST, hard override) ------------
    // If our CURRENT tile will ignite within the FLEE HORIZON — sized so we have
    // the lead time to clear a full maxEscapeLen route at our current speed —
    // override EVERYTHING and RUN, before the pocket closes. This runs BEFORE the
    // forward search (a hard safety net the search can never trade away for
    // tempo): the search and commitment only matter once we are not actively
    // fleeing. Flee to the nearest TRULY-safe tile via a danger-aware BFS
    // (interval model); if none is reachable, step toward the open neighbour with
    // the LATEST fire (and NEVER onto a tile burning now). When this net fires we
    // INTERRUPT the goal commitment (a fresh threat overrides any goal).
    const fleeHorizon = Math.max(
      SURV_REACTION_WINDOW,
      this.tuning.maxEscapeLen * tpt +
        this.tuning.reactionDelayTicks +
        TRAVEL_SLACK_TICKS,
    );
    if (myDangerEarliest !== undefined && myDangerEarliest <= fleeHorizon) {
      this.goal.interrupt();
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

    // ---- PESSIMISTIC SCENARIOS (maximin) -----------------------------------
    // A small fixed set of worst-case opponent danger maps (baseline + opponent
    // pressure + lane-block). The search takes MIN survivability over them.
    const scenarios = buildScenarios(
      state,
      myX,
      myY,
      slot,
      myTeam,
      foeReachTiles,
    );

    // ---- COMMITMENT UPDATE (anti-dither goal hysteresis) -------------------
    // Decide the desired goal this tick: FIGHT the nearest reachable foe tile, or
    // FARM the growth target tile. This NEVER bypasses the search or the safety
    // gate — it only records a goal whose anti-backtrack penalty (recorded on the
    // PREVIOUS tile) shifts search leaf scores to suppress oscillation.
    const fightFoeHit =
      foeTilesNow.size > 0
        ? bfsFirstStep(
            state,
            myX,
            myY,
            (x, y) => foeTilesNow.has(idx(x, y)),
            openPassable(state),
          )
        : null;
    let desiredKind: 'FIGHT' | 'FARM' | null = null;
    let desiredX = -1;
    let desiredY = -1;
    let desiredHold = 0;
    let desiredDir = Direction.NONE as number;
    if (fightFoeHit !== null && foeDist <= foeReachTiles) {
      desiredKind = 'FIGHT';
      desiredX = fightFoeHit.target[0];
      desiredY = fightFoeHit.target[1];
      desiredHold = FIGHT_HOLD_TICKS;
      desiredDir = fightFoeHit.firstDir;
    } else if (growthFirstDir !== Direction.NONE && growthDist > 0) {
      desiredKind = 'FARM';
      desiredX = myX + dirDX(growthFirstDir);
      desiredY = myY + dirDY(growthFirstDir);
      desiredHold = FARM_HOLD_TICKS;
      desiredDir = growthFirstDir;
    }

    // ---- FORWARD SEARCH (depth-limited maximin) ----------------------------
    // Bind the v1 reward/survivability math + the pessimistic bomb gate as
    // callbacks so the search reuses them verbatim. The commitment's penaltyFor
    // (recorded last tick) feeds the leaf evaluation — anti-dither only.
    const start: SearchState = {
      x: myX,
      y: myY,
      bombsPlaced: 0,
      activeBombs: myPlayer.activeBombs,
      cannon: myPlayer.cannon,
      fire: myPlayer.fire,
      tickOffset: 0,
      accReward: 0,
    };
    const baseOpen = openPassable(state);
    // Per-sample memo caches: the search revisits the same tiles across branches,
    // and every term is a PURE function of (scenario, tile) within one decision
    // tick, so caching is behaviour-preserving (identical integer results) and
    // cuts the dominant survivability-flood cost by an order of magnitude.
    const survCache = new Map<number, number>();
    const rewardCache = new Map<number, number>();
    const gateCache = new Map<number, boolean>();
    const survAt = (scIndex: number, sc: IntervalDanger, rx: number, ry: number): number => {
      const key = scIndex * MAP_COLS * MAP_ROWS + idx(rx, ry);
      const hit = survCache.get(key);
      if (hit !== undefined) return hit;
      const v = this.survivability(state, sc, rx, ry);
      survCache.set(key, v);
      return v;
    };
    const result = forwardSearch(
      state,
      scenarios,
      start,
      wAttack,
      tpt,
      STEP_DANGER_HORIZON,
      baseOpen,
      {
        survivability: (sc, rx, ry) => {
          // Identify the scenario by reference to key the cache deterministically.
          let scIndex = 0;
          for (let s = 0; s < scenarios.length; s++) {
            if (scenarios[s] === sc) {
              scIndex = s;
              break;
            }
          }
          return survAt(scIndex, sc, rx, ry);
        },
        leafReward: (rx, ry, bombHere, fire) => {
          const key = (idx(rx, ry) << 1) | (bombHere ? 1 : 0);
          const hit = rewardCache.get(key);
          if (hit !== undefined) return hit;
          const v = this.leafReward(
            state,
            slot,
            myTeam,
            myX,
            myY,
            rx,
            ry,
            bombHere,
            fire,
            scenarios[0]!,
            wAttack,
            tpt,
            growthFirstDir,
            growthDist,
            effDevFactor,
            inPlaceBricks,
          );
          rewardCache.set(key, v);
          return v;
        },
        penaltyFor: (rx, ry) => this.goal.penaltyFor(rx, ry),
        bombGateOk: (bx, by, fire) => {
          const key = idx(bx, by);
          const cached = gateCache.get(key);
          if (cached !== undefined) return cached;
          const ok = this.computeBombGateOk(
            state,
            slot,
            myTeam,
            bx,
            by,
            fire,
            tpt,
            foeReachTiles,
          );
          gateCache.set(key, ok);
          return ok;
        },
      },
    );

    const perAction = result.perActionScores;
    // Map a root action to its first-step direction.
    const actionDir = (a: RootAction): number => {
      switch (a) {
        case RootAction.UP:
          return Direction.UP;
        case RootAction.DOWN:
          return Direction.DOWN;
        case RootAction.LEFT:
          return Direction.LEFT;
        case RootAction.RIGHT:
          return Direction.RIGHT;
        default:
          return Direction.NONE; // STAY / PLACE_BOMB
      }
    };
    // The root action index whose direction equals `dir` (STAY for NONE).
    const actionForDir = (dir: number): RootAction => {
      switch (dir) {
        case Direction.UP:
          return RootAction.UP;
        case Direction.DOWN:
          return RootAction.DOWN;
        case Direction.LEFT:
          return RootAction.LEFT;
        case Direction.RIGHT:
          return RootAction.RIGHT;
        default:
          return RootAction.STAY;
      }
    };

    // ---- GOAL HYSTERESIS ---------------------------------------------------
    // Use SEARCH-derived per-action scores to decide whether to keep or switch
    // the committed goal. While a commitment is active we only SWITCH to the
    // desired (challenger) goal if its aligned root-action score beats the
    // committed goal's aligned score by more than COMMIT_HYSTERESIS. This biases
    // toward continuity (kills oscillation) without ever bypassing the search.
    if (this.goal.isActive()) {
      // First-step direction toward the committed goal target (fresh BFS so it
      // tracks the live state). STAY if unreachable / already there.
      const goalHit = bfsFirstStep(
        state,
        myX,
        myY,
        (x, y) => x === this.goal.targetX && y === this.goal.targetY,
        openPassable(state),
      );
      const committedDir = actionForDir(
        goalHit === null ? Direction.NONE : goalHit.firstDir,
      );
      const committedScore = perAction[committedDir] ?? Number.NEGATIVE_INFINITY;
      const challengerDir =
        desiredDir === Direction.NONE
          ? RootAction.STAY
          : actionForDir(desiredDir);
      const challengerScore = perAction[challengerDir] ?? Number.NEGATIVE_INFINITY;
      const challengerWins =
        desiredKind !== null &&
        (desiredKind !== this.goal.kind ||
          desiredX !== this.goal.targetX ||
          desiredY !== this.goal.targetY) &&
        challengerScore - committedScore > COMMIT_HYSTERESIS;
      if (challengerWins) {
        this.goal.update(desiredX, desiredY, desiredKind, desiredHold, myX, myY);
      }
    } else if (desiredKind !== null) {
      this.goal.update(desiredX, desiredY, desiredKind, desiredHold, myX, myY);
    }
    this.goal.tick();

    // ---- DECIDE THE ACTION -------------------------------------------------
    let bestAction = result.bestAction;
    // bombChance throttle (POST-search): if the search wants to bomb but a
    // bombChance roll fails, downgrade to the best non-bomb root action.
    if (bestAction === RootAction.PLACE_BOMB) {
      if (this.randFloat() >= this.tuning.bombChance) {
        bestAction = this.bestNonBombAction(perAction);
      }
    }

    // Best survivability-safe non-bomb runner-up (used by the mistake fallback
    // and the bomb-gate fallback). Fixed order, strict `>`, first wins.
    const runnerUp = this.bestNonBombAction(perAction);

    // ---- MISTAKE / RECKLESS HUMANIZATION -----------------------------------
    // One randFloat per decision (preserves v1 RNG-stream parity at this point).
    // On a mistake, fall back to the runner-up non-bomb action. easy-only
    // reckless: with prob recklessBombChance, allow a reckless self-bomb that
    // relaxes the timing gate to a best-effort refuge — only when the drop would
    // actually hit a foe (combat-only, like v1). normal/hard reckless = 0.
    const canBomb =
      myPlayer.activeBombs < myPlayer.cannon &&
      bombAt(state.bombs, myX, myY) === undefined;
    let recklessRefuge: readonly [number, number] | null = null;
    if (this.randFloat() < this.tuning.mistakeChance) {
      const bombCand: Candidate = {
        dir: Direction.NONE,
        bomb: true,
        rx: myX,
        ry: myY,
        score: 0,
        survSafe: false,
        refugeX: -1,
        refugeY: -1,
      };
      const worthDrop =
        this.enemyPressure(
          state,
          slot,
          myTeam,
          bombCand,
          myPlayer.fire,
          scenarios[0]!,
        ) > 0;
      const bombGateFails =
        perAction[RootAction.PLACE_BOMB] === Number.NEGATIVE_INFINITY;
      if (
        this.tuning.recklessBombChance > 0 &&
        this.randFloat() < this.tuning.recklessBombChance &&
        canBomb &&
        worthDrop &&
        bombGateFails
      ) {
        const safe = findNearestSafe(state, myX, myY, gridDanger);
        if (safe !== null) {
          recklessRefuge = safe;
          bestAction = RootAction.PLACE_BOMB;
        }
      } else if (runnerUp !== bestAction) {
        bestAction = runnerUp;
      }
    }

    // ---- EMIT --------------------------------------------------------------
    if (bestAction === RootAction.PLACE_BOMB) {
      // Re-validate the bomb drop with the pessimistic gate (unless this is the
      // easy reckless path, which already has a best-effort refuge).
      let refuge = recklessRefuge;
      if (refuge === null) {
        refuge = canBomb
          ? this.validateBombRefugePessimistic(
              state,
              slot,
              myTeam,
              myX,
              myY,
              myPlayer.fire,
              tpt,
              foeReachTiles,
            )
          : null;
        if (
          refuge !== null &&
          this.bombHitsTeammate(state, slot, myTeam, myX, myY, myPlayer.fire)
        ) {
          refuge = null;
        }
      }
      if (refuge !== null) {
        this.committedDir = Direction.NONE as number;
        this.committedTicks = 0;
        this.escapeTargetX = refuge[0];
        this.escapeTargetY = refuge[1];
        this.escapeTicks = 0;
        // Record the goal target for next tick's anti-backtrack (bomb in place).
        if (desiredKind !== null) {
          this.goal.update(desiredX, desiredY, desiredKind, desiredHold, myX, myY);
        }
        return { dir: Direction.NONE, action: ActionFlags.BOMB };
      }
      // Gate failed → fall back to the best non-bomb root action.
      bestAction = runnerUp;
    }

    // Move / STAY.
    const dir = actionDir(bestAction);
    // Record the goal target for next tick's anti-backtrack.
    if (desiredKind !== null) {
      this.goal.update(desiredX, desiredY, desiredKind, desiredHold, myX, myY);
    }
    this.commit(dir);
    return { dir, action: ActionFlags.NONE };
  }

  /** Pick the best NON-bomb root action (STAY/UP/DOWN/LEFT/RIGHT). */
  private bestNonBombAction(perAction: readonly number[]): RootAction {
    let best = RootAction.STAY;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (
      let a = RootAction.STAY as number;
      a <= RootAction.RIGHT;
      a++
    ) {
      const s = perAction[a] ?? Number.NEGATIVE_INFINITY;
      if (s > bestScore) {
        bestScore = s;
        best = a as RootAction;
      }
    }
    return best;
  }
}
