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
import { SPIRAL_ORDER } from '../../sim/SuddenDeath';
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
  SUDDEN_DEATH_START_TICK,
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
  COMMIT_HYSTERESIS,
  FARM_HOLD_TICKS,
  FIGHT_HOLD_TICKS,
  GoalCommitment,
} from './core/commitment';
import { MAX_SCENARIO_ENEMIES, buildScenarios } from './core/scenarios';
import {
  type SearchKnobs,
  type SearchState,
  RootAction,
  forwardSearch,
} from './core/forwardSearch';
import type { MapProfile } from './MapProfile';
import { CLASSIC_PROFILE } from './classic/MapProfile';
import { PIRATE_PROFILE } from './pirate/MapProfile';

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
// Scoring weights (integer; survivability — weighted W_SURVIVE=1000 inside the
// forward search, see core/forwardSearch.ts — dominates; W_POSITION smallest).
// Each term returns a small bounded non-negative integer so the weighted sum
// cannot overflow.
// ---------------------------------------------------------------------------
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

/**
 * foeDist (open-path BFS hops) at/above which the bot has NO open path to any
 * foe — "isolated" / pre-connection. foeDist is capped at 40 in sample(), so
 * this equals the cap: only a genuine open contact (foeDist < 40) ends isolation.
 */
const ISOLATED_FOE_DIST = 40;

/**
 * Cap on the cut-off / cornering reward (v3): a bomb that walls off a near foe's
 * escape (without a direct hit) is worth at most this many "covered escapes",
 * kept below the 1..5 direct-hit value so a real hit is always preferred.
 */
const CUTOFF_CAP = 3;

/** Weight of the protect-the-lead retreat term (reward per tile of foe distance). */
const W_RETREAT = 40;
/** Cap on the retreat distance bonus (Manhattan hops from the nearest foe). */
const RETREAT_CAP = 8;
/**
 * Open-path foe distance under which protect-the-lead retreat engages (wider than
 * cautionDist so the bot backs off BEFORE the foe closes into kill range).
 */
const PROTECT_LEAD_DIST = 12;

// ---------------------------------------------------------------------------
// KILL DOCTRINE (v3, new win rule: a 3-min timeout is a CHALLENGER LOSS, so a
// material/development lead is worthless — only an actual kill within the time
// limit wins). The bot must HUNT: stop farming-to-timeout, close on the foe, and
// monotonically COMPRESS the foe's time-aware free space (the count of safe
// reachable tiles it can still flee to) until a bomb seals it. These terms drive
// that, all while the hard survival gate (W_SURVIVE + bomb-refuge) is untouched —
// the bot never self-traps; it just converts a survivable position into a kill.
// ---------------------------------------------------------------------------

/**
 * The tick after which CLOCK URGENCY begins ramping 0→100 is now PER-MAP
 * (`MapProfile.huntStartTick`): before it the bot develops a minimal trap kit
 * (cannon/fire) at full economy; after it economy/growth fade and the seal /
 * survivability-clamp terms scale up, so the back of the match is spent cornering
 * the foe instead of farming. Pirate keeps the 2400-tick (40 s) default; classic
 * engages earlier (see classic/MapProfile.ts).
 */
/** Tick at which urgency reaches 100 (full hunt). Earlier than the cap so the
 * whole back half of the match is fought at max aggression, not just the final
 * seconds. */
const T_HUNT_FULL = 9000;
/** Floor on the hunt-approach scale so the bot ALWAYS camps near the foe (in
 * position to seal its escape the instant it commits a bomb), more so late. */
const HUNT_FACTOR_FLOOR = 35;

/** Weight of the FREE-SPACE SEAL term: reward (per safe tile removed from the
 * foe's reachable refuge) a bomb that compresses the foe's escape space. Sized
 * so a strong compression rivals survivability once urgency is high, but the
 * bomb still had to pass the same refuge gate (no self-trap). */
const W_SEAL = 130;
/** Cap on raw compression (safe tiles removed from the foe's refuge component). */
const SEAL_COMPRESS_CAP = 12;
/** Bonus when a bomb chokes the foe's instantaneous refuge to ≤1 tile (a herding
 * milestone, not yet a kill — the fuse still gives the foe time to slip out). */
const SEAL_CHOKE_BONUS = 24;
/**
 * Bonus for a FUSE-AWARE genuine kill: the foe's survivability flood (against the
 * interval danger map WITH this hypothetical bomb + every live bomb) collapses to
 * a doomed pocket — it cannot reach any refuge over the bomb's real detonation
 * timeline. Huge (× W_SEAL) so the bot ALWAYS takes a real kill; safe to be huge
 * because it only fires on a verified trap, never a transient choke. */
const SEAL_TRUE_KILL = 80;
/** Foe survivability at/under which the foe is a doomed pocket (cf. survivability:
 * a no-refuge pocket collapses to ≤1; 0 = already burning where it stands). */
const FOE_DOOM_THRESHOLD = 1;
/** MINIMAX forced-trap: only attempt the 2-bomb forced kill when the foe's post-
 * B1 forced refuge set is at most this many tiles — a near-cornered foe a second
 * bomb can actually seal. Larger = the open map where forcing is impossible, so we
 * skip (this is exactly why pirate stays low; classic corridors hit it). */
const TRAP_R1_MAX = 5;
/** Cap on the foe-refuge BFS set size (cost bound). */
const TRAP_SET_CAP = 10;
/** BFS visited-cell budget when measuring the foe's free space (cheap, bounded). */
const FREE_SPACE_CAP = 16;

/** Weight of the HUNT-APPROACH term: reward ending CLOSER to the nearest foe
 * (replaces the protect-lead retreat once the clock is running). */
const W_HUNT = 12;
/** Cap on the approach bonus (Manhattan hops from the nearest foe, inverted). */
const HUNT_CAP = 12;
/** Lowest the close-quarters survivability CLAMP falls to at full urgency: the
 * bot still demands this many safe ticks of breathing room (gate-passed), but
 * beyond it the foe-compression reward decides. Floors aggression so a hunt
 * never degenerates into trading its own life. */
const HUNT_SURV_FLOOR = 4;

/** Center tile (used by positionValue): floor(MAP_COLS/2), floor(MAP_ROWS/2). */
const CENTER_X = Math.floor(MAP_COLS / 2); // 7
const CENTER_Y = Math.floor(MAP_ROWS / 2); // 6

/**
 * Per-tile SUDDEN-DEATH SURVIVAL RANK: how LATE a tile hardens in the inward
 * spiral (sim/SuddenDeath SPIRAL_ORDER) — higher = survives the shrink longer
 * (the center is last). Border / non-interior tiles get 0 (never standable late).
 * Pure compile-time constant of the map dimensions; the shrink-survival term
 * (gated by MapProfile.shrinkSurvivalWeight) pulls toward higher-rank tiles as
 * the shrink nears, so the bot drifts to the surviving center BEFORE the wall
 * arrives instead of only reacting once tiles are already hard. */
const SHRINK_SURVIVAL_RANK: Int32Array = (() => {
  const rank = new Int32Array(MAP_COLS * MAP_ROWS);
  for (let i = 0; i < SPIRAL_ORDER.length; i++) {
    const [x, y] = SPIRAL_ORDER[i]!;
    rank[idx(x, y)] = i; // 0 = first to harden (outer ring), last = center.
  }
  return rank;
})();
/** Ticks BEFORE the shrink starts that the survival pull begins ramping in. */
const SHRINK_LEAD_TICKS = 1800; // ~30 s — drift to center from ~90 s onward.
/** Foe free-space at/below which CORNER-FINISH considers the foe cornered (dive
 * in to seal rather than orbit at the ring). Only active when cornerFinish is on
 * (classic). Measured: 3 is best — widening to 5 (dive on semi-cornered foes)
 * over-exposes the bot since the foe is not actually trapped (1670 vs 1701). */
const CORNER_FREE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// v5 ANTI-ENTRAPMENT (NEW defensive axis — see MapProfile.entrapWeight).
// v4's binding ceiling (v3:trapper) and the player-observed deaths are the SAME
// failure: the bot ducks into a dead-end / single-exit pocket near a foe and one
// follow-up "seal" bomb kills it. The fix is to keep ESCAPE REDUNDANCY under foe
// pressure — prefer tiles with >=2 independent safe escape branches.
// ---------------------------------------------------------------------------
/** Escape branches at/above which a tile is "robust" (no entrapment penalty). A
 * dead-end / single-exit pocket yields <=1; we want at least two ways out so no
 * single foe follow-up bomb can seal every escape. */
const ENTRAP_BRANCH_TARGET = 2;
/** Per-branch flood visited-cell budget when measuring escape branches (cheap,
 * bounded; only runs while a foe is within combat range). */
const ENTRAP_FLOOD_CAP = 12;

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

  /** Effective Zoner stand-off ring radius for THIS decision: the per-map
   * `MapProfile.zoneStandoffTiles` override when set (>0), else the archetype's
   * own `tuning.zoneStandoff`. Resolved once per decision tick (profile in scope)
   * and read by leafReward (which has no profile param). 0 = not a Zoner. */
  private curZoneStandoff = 0;

  /** Effective shrink-survival pull weight for THIS decision (per-map
   * `MapProfile.shrinkSurvivalWeight`); 0 = off. Read by leafReward. */
  private curShrinkWeight = 0;

  /** Effective CANNON development target for THIS decision (per-map
   * `MapProfile.devTargetCannon`); read by developmentFactor. Classic raises it
   * to the max so the bot accumulates a multi-bomb surplus for corner seals. */
  private curDevTargetCannon = DEV_TARGET_CANNON;

  /** Effective FIRE development target for THIS decision (per-map
   * `MapProfile.devTargetFire`); read by developmentFactor and the item-priority
   * threshold. Classic raises it so the bot grows a longer blast cross — stronger
   * seals / corner walls that cover more exits and reach fleeing foes. */
  private curDevTargetFire = DEV_TARGET_FIRE;

  /** Whether CORNER-FINISH is active for THIS decision (per-map
   * `MapProfile.cornerFinish`): when the nearest foe is cornered (free space
   * collapsed) the Zoner ring collapses so the bot dives in to seal it. */
  private curCornerFinish = false;

  /** Effective max early-economy boost % for THIS decision (per-map
   * `MapProfile.devEconBoostMax`); read by leafReward. Classic raises it so the
   * bot out-develops the v3 peers in the opening (reaches the fire-6 kit faster).
   * Fades to 0 as the bot develops / engages, so it only accelerates early. */
  private curEconBoostMax = DEV_ECON_BOOST_MAX;

  /** Effective SEAL reward multiplier (%) for THIS decision (per-map
   * `MapProfile.sealWeightMult`); 100 = unscaled. Classic raises it so the bot
   * commits harder to closing a trap (bricks + the foe's own live bombs, which
   * sealValue already folds in) rather than orbiting — killing power, not farming. */
  private curSealMult = 100;

  /** Effective v5 ANTI-ENTRAPMENT weight for THIS decision (per-map
   * `MapProfile.entrapWeight`); 0 = off. Read by leafReward to penalise result
   * tiles that are dead-ends / single-exit pockets while a foe is near. */
  private curEntrapWeight = 0;

  /** Effective v5 ROBUST-REFUGE flag for THIS decision (per-map
   * `MapProfile.robustRefuge`); when true the bomb-COMMIT refuge is the most-
   * escapable one, not just the nearest. classic on, pirate off. */
  private curRobustRefuge = false;

  /** Effective v5 CORRIDOR-GATE flag for THIS decision (per-map
   * `MapProfile.corridorGate`); when true a bomb is vetoed if — with a foe in
   * combat range — its only refuge is a single-exit corridor (escapeBranches < 2)
   * a follow-up seal can cap. classic on, pirate off. */
  private curCorridorGate = false;

  /** 反應流 Reactive: nearest-foe tile + foe bomb count seen LAST decision, so we
   * can derive the foe's last action (move direction / fresh bomb) to mirror. */
  private lastFoeTile = -1;
  private lastFoeBombs = 0;

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

  /**
   * Per-map decision profile (classic / pirate). Selected LAZILY from
   * SimState.mapKind on the first sample() and cached for the match (mapKind is
   * a whole-match constant). null = not yet selected. Both profiles are NEUTRAL
   * today, so this dispatch is byte-identical to committed v2 either way; the
   * seam exists so a later pass can let classic diverge from pirate.
   */
  private profile: MapProfile | null = null;

  /**
   * Optional ship-safe override: when non-null it REPLACES the SimState.mapKind
   * dispatch in profileFor(), so a caller (e.g. the throwaway sweep harness) can
   * inject a single candidate profile into the bot. null (the default) = the
   * normal per-map dispatch → byte-identical to committed v2.
   */
  private readonly profileOverride: MapProfile | null;

  constructor(
    rngSeed: number,
    tuning: BotTuning,
    slot: number,
    profileOverride: MapProfile | null = null,
  ) {
    this.rng = rngSeed >>> 0;
    this.tuning = tuning;
    this.ctorSlot = slot;
    this.profileOverride = profileOverride;
  }

  /**
   * Select the per-map profile. When an explicit override was supplied to the
   * constructor it wins outright; otherwise dispatch on SimState.mapKind —
   * classic vs pirate; any unknown value defaults to classic (a safe neutral).
   * Pure / deterministic.
   */
  private profileFor(state: SimState): MapProfile {
    if (this.profileOverride !== null) return this.profileOverride;
    return state.mapKind === 'pirate' ? PIRATE_PROFILE : CLASSIC_PROFILE;
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

  /**
   * 反應流 Reactive — a pure counter-puncher: shadow the foe's last movement and
   * POUNCE (seal its escape) the instant it commits a fresh bomb; never leads the
   * tempo. Every action is safety-gated via `safeInterval`, so it cannot suicide.
   * Reads the foe's "last action" from the tracked nearest-foe tile + enemy bomb
   * count. Deterministic (fixed iteration order, threaded RNG only for the safe
   * fallback wander). Returns the InputFrame to play this tick.
   */
  private reactiveAction(
    state: SimState,
    slot: number,
    myTeam: number,
    myX: number,
    myY: number,
    myPlayer: { activeBombs: number; cannon: number; fire: number },
    tpt: number,
    foeReachTiles: number,
    safeInterval: Passable,
    foeTileIdx: number,
  ): InputFrame {
    // Count enemy bombs currently live (a rise = the foe's last action was a bomb).
    let foeBombs = 0;
    for (const b of state.bombs) {
      for (const p of state.players) {
        if (p.slot === b.ownerSlot) {
          if (p.team !== myTeam) foeBombs += 1;
          break;
        }
      }
    }
    let dir = Direction.NONE as number;
    let bomb = false;
    if (foeTileIdx >= 0) {
      const fx = foeTileIdx % MAP_COLS;
      const fy = (foeTileIdx - fx) / MAP_COLS;
      const man = Math.abs(myX - fx) + Math.abs(myY - fy);
      const foeBombed = foeBombs > this.lastFoeBombs;
      if (
        foeBombed &&
        man <= foeReachTiles &&
        myPlayer.activeBombs < myPlayer.cannon &&
        bombAt(state.bombs, myX, myY) === undefined &&
        !this.bombHitsTeammate(state, slot, myTeam, myX, myY, myPlayer.fire) &&
        this.computeBombGateOk(state, slot, myTeam, myX, myY, myPlayer.fire, tpt, foeReachTiles)
      ) {
        bomb = true; // POUNCE on the foe's committed bomb.
      } else if (this.lastFoeTile >= 0) {
        // MIRROR: step the SAME direction the foe just moved (shadow it), if safe.
        const lfx = this.lastFoeTile % MAP_COLS;
        const lfy = (this.lastFoeTile - lfx) / MAP_COLS;
        const ddx = fx - lfx;
        const ddy = fy - lfy;
        let cand = Direction.NONE as number;
        if (Math.abs(ddx) >= Math.abs(ddy) && ddx !== 0) {
          cand = ddx > 0 ? Direction.RIGHT : Direction.LEFT;
        } else if (ddy !== 0) {
          cand = ddy > 0 ? Direction.DOWN : Direction.UP;
        }
        if (cand !== Direction.NONE && this.dirOk(myX, myY, cand, safeInterval)) {
          dir = cand;
        }
      }
      // Fall back to stepping toward the foe (counter its position) if no mirror.
      if (!bomb && dir === Direction.NONE) {
        const toward = bfsFirstStep(
          state,
          myX,
          myY,
          (x, y) => x === fx && y === fy,
          safeInterval,
        );
        if (
          toward !== null &&
          toward.firstDir !== Direction.NONE &&
          this.dirOk(myX, myY, toward.firstDir, safeInterval)
        ) {
          dir = toward.firstDir;
        }
      }
    }
    if (!bomb && dir === Direction.NONE) {
      dir = this.randomSafeDir(myX, myY, safeInterval);
    }
    this.lastFoeTile = foeTileIdx;
    this.lastFoeBombs = foeBombs;
    if (bomb) return { dir: Direction.NONE, action: ActionFlags.BOMB };
    if (dir !== Direction.NONE) this.commit(dir);
    return { dir, action: ActionFlags.NONE };
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
   * v5 ANTI-ENTRAPMENT: count the DISTINCT safe escape branches out of (rx,ry).
   * For each open cardinal neighbour that is steppable (non-lethal within the near
   * horizon), flood outward — FORBIDDING re-entry to (rx,ry), bounded by
   * ENTRAP_FLOOD_CAP — and count that neighbour as a branch iff its flood reaches a
   * TRULY-safe tile (never lethal within the safe horizon). A dead-end / single-exit
   * pocket yields ≤1 branch; a junction yields ≥2. The forbidden self tile is the
   * key: it models that a foe follow-up bomb on (rx,ry)'s only exit corridor seals
   * the bot, so two branches that both funnel back through the SAME single neighbour
   * still read as one. Pure / deterministic (DIRECTION_ORDER, integer, no RNG).
   */
  private escapeBranches(
    state: SimState,
    danger: IntervalDanger,
    rx: number,
    ry: number,
  ): number {
    const base = openPassable(state);
    const selfIdx = idx(rx, ry);
    let branches = 0;
    for (const d of DIRECTION_ORDER) {
      const nx = rx + dirDX(d);
      const ny = ry + dirDY(d);
      if (!inBounds(nx, ny) || !base(nx, ny)) continue;
      const nIdx = idx(nx, ny);
      const ne = danger.earliestLethal(nIdx);
      if (ne !== undefined && ne <= STEP_DANGER_HORIZON) continue; // can't step here.
      // Flood from this neighbour, never re-entering the self tile, until a truly-
      // safe tile is reached or the budget runs out.
      const seen = new Set<number>([selfIdx, nIdx]);
      const queue: number[] = [nIdx];
      let head = 0;
      let reached = false;
      let visited = 0;
      while (head < queue.length && visited < ENTRAP_FLOOD_CAP) {
        const cur = queue[head]!;
        head += 1;
        visited += 1;
        const e = danger.earliestLethal(cur);
        if (e === undefined || e > SURV_SAFE_HORIZON) {
          reached = true;
          break;
        }
        const cx = cur % MAP_COLS;
        const cy = (cur - cx) / MAP_COLS;
        for (const dd of DIRECTION_ORDER) {
          const mx = cx + dirDX(dd);
          const my = cy + dirDY(dd);
          if (!inBounds(mx, my) || !base(mx, my)) continue;
          const mi = idx(mx, my);
          if (seen.has(mi)) continue;
          const me = danger.earliestLethal(mi);
          if (me !== undefined && me <= STEP_DANGER_HORIZON) continue;
          seen.add(mi);
          queue.push(mi);
        }
      }
      if (reached) branches += 1;
    }
    return branches;
  }

  /**
   * KILL DOCTRINE: the foe's time-aware FREE SPACE — a small BFS count of the
   * safe tiles the foe at (fx,fy) can still flee to and DWELL on. A tile counts
   * iff it is open, reachable from the foe (BFS through open tiles, but NOT
   * through `block`), and non-lethal past the safe horizon (and not in `block`).
   * `block` is a hypothetical bomb's blast cross treated as a future wall, so
   * foeFreeSpace(...blast) < foeFreeSpace(...null) measures how much that bomb
   * compresses the foe — the scalar the seal term drives toward 0. Capped at
   * FREE_SPACE_CAP. Pure / deterministic (DIRECTION_ORDER, integer, no RNG).
   */
  private foeFreeSpace(
    state: SimState,
    danger: IntervalDanger,
    fx: number,
    fy: number,
    block: Set<number> | null,
  ): number {
    const base = openPassable(state);
    const startI = idx(fx, fy);
    const seen = new Set<number>([startI]);
    const queue: number[] = [startI];
    let head = 0;
    let count = 0;
    while (head < queue.length && count < FREE_SPACE_CAP) {
      const cur = queue[head]!;
      head += 1;
      const cx = cur % MAP_COLS;
      const cy = (cur - cx) / MAP_COLS;
      const blocked = block !== null && block.has(cur);
      const e = danger.earliestLethal(cur);
      const safeDwell = !blocked && (e === undefined || e > SURV_SAFE_HORIZON);
      if (safeDwell) count += 1;
      for (const d of DIRECTION_ORDER) {
        const nx = cx + dirDX(d);
        const ny = cy + dirDY(d);
        if (!inBounds(nx, ny) || !base(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (seen.has(ni)) continue;
        if (block !== null && block.has(ni)) continue; // blast walls off the path.
        seen.add(ni);
        queue.push(ni);
      }
    }
    return count;
  }

  /**
   * MINIMAX: the SET of safe-dwell tiles the foe can reach (its survival-
   * maximising refuge options) from `sources` under `danger` — a multi-source
   * version of foeFreeSpace that returns the tiles, not just a count, so the
   * forced-trap planner can use the foe's forced refuge R1 as the start set for
   * the second bomb. Same dwell/expansion rules as survivability (safe-dwell =
   * never lethal within the safe horizon; never expand through a tile lethal in
   * the near horizon). Capped. Deterministic (DIRECTION_ORDER, integer).
   */
  private foeSafeSet(
    state: SimState,
    danger: IntervalDanger,
    sources: Iterable<number>,
    cap: number,
  ): number[] {
    const base = openPassable(state);
    const seen = new Set<number>();
    const queue: number[] = [];
    for (const s of sources) {
      if (!seen.has(s)) {
        seen.add(s);
        queue.push(s);
      }
    }
    const safe: number[] = [];
    let head = 0;
    while (head < queue.length && safe.length < cap) {
      const cur = queue[head]!;
      head += 1;
      const cx = cur % MAP_COLS;
      const cy = (cur - cx) / MAP_COLS;
      const e = danger.earliestLethal(cur);
      if (e === undefined || e > SURV_SAFE_HORIZON) safe.push(cur);
      for (const d of DIRECTION_ORDER) {
        const nx = cx + dirDX(d);
        const ny = cy + dirDY(d);
        if (!inBounds(nx, ny) || !base(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (seen.has(ni)) continue;
        const ne = danger.earliestLethal(ni);
        if (ne !== undefined && ne <= STEP_DANGER_HORIZON) continue; // can't cross fire.
        seen.add(ni);
        queue.push(ni);
      }
    }
    return safe;
  }

  /**
   * KILL DOCTRINE: the free-space SEAL value of a PLACE_BOMB candidate — how much
   * it compresses the nearest attackable foe's free space (foeFreeSpace before vs
   * after the bomb's blast is added as a wall), with a CHOKE bonus as that space
   * collapses to ≤1 tile and a big KILL bonus when it hits 0 (the foe has no safe
   * tile left = a trap). 0 for non-bomb actions, friendly-fire bombs, or a foe
   * too far for the blast to plausibly box in (so it never pulls the bot off
   * productive play far from any foe). This is the heuristic that converts a
   * survivable position into a kill — the bomb still passes the same refuge gate.
   */
  private sealValue(
    state: SimState,
    slot: number,
    myTeam: number,
    cand: Candidate,
    fire: number,
    danger: IntervalDanger,
  ): number {
    if (!cand.bomb) return 0;
    const blast = this.blastTiles(state, cand.rx, cand.ry, fire);
    // Never reward a bomb that would also hit a teammate (mirror enemyPressure).
    for (const p of state.players) {
      if (p.slot === slot) continue;
      if (p.team !== myTeam || !p.alive || p.trapped) continue;
      if (blast.has(idx(tileOf(p.posX), tileOf(p.posY)))) return 0;
    }
    let best = 0;
    let dangerWithBomb: IntervalDanger | null = null; // built lazily (expensive).
    for (const p of state.players) {
      if (p.slot === slot || p.team === myTeam) continue;
      if (!p.alive || p.trapped) continue;
      const ex = tileOf(p.posX);
      const ey = tileOf(p.posY);
      // Only a foe the blast can plausibly box in; else a distant foe would make
      // every bomb look like a seal.
      if (Math.abs(ex - cand.rx) + Math.abs(ey - cand.ry) > fire + 2) continue;
      // A foe with an adjacent ally is likely re-rescued — not a clean seal.
      if (this.foeHasAllyAdjacent(state, p.slot, p.team, ex, ey)) continue;
      // Cheap INSTANTANEOUS compression — the HERDING gradient: how many safe
      // tiles this bomb's cross removes from the foe's refuge right now. Drives
      // the bot to keep squeezing the foe toward a corner where a true trap forms.
      const before = this.foeFreeSpace(state, danger, ex, ey, null);
      const after = this.foeFreeSpace(state, danger, ex, ey, blast);
      let v = Math.min(Math.max(0, before - after), SEAL_COMPRESS_CAP);
      // FUSE-AWARE FINISH: an instantaneous choke does NOT kill — the 180-tick
      // fuse gives the foe 3 s to walk out. The real kill is when the foe, over
      // the bomb's actual detonation timeline (interval danger model, incl. ALL
      // live bombs — the foe's own + ours), has NO refuge: its survivability
      // flood collapses to a doomed pocket. Only probe this (expensive: a full
      // danger-map build) when the cheap signal says the foe is already nearly
      // boxed (after ≤ 1), so genuine multi-bomb traps — including punishing the
      // foe as it flees its OWN bomb into ours — get the decisive reward while
      // distant or open foes cost nothing.
      if (after <= 1) {
        v += SEAL_CHOKE_BONUS;
        if (dangerWithBomb === null) {
          const hyp = hypotheticalBomb(cand.rx, cand.ry, fire, slot);
          dangerWithBomb = buildDangerMap(state, [hyp]);
        }
        const foeSurv = this.survivability(state, dangerWithBomb, ex, ey);
        if (foeSurv <= FOE_DOOM_THRESHOLD) v += SEAL_TRUE_KILL;
      }
      if (v > best) best = v;
    }
    return best;
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
      // CUT-OFF / CORNERING (v3): even when the blast does NOT directly hit a foe,
      // reward a bomb that WALLS OFF a near foe's escape — covering the tiles it
      // would flee to. This corners a fleeing foe (sets up a kill the next ply,
      // which the depth-4 search can follow) and pressures it OFF its farming. It
      // is deliberately weaker than a direct hit (capped at CUTOFF_CAP=3 < the
      // 1..5 direct-hit value), only considered when there is no direct hit
      // (best === 0), and only for a foe within blast range, so it never pulls the
      // bot off a real hit and stays gated by the same refuge check as any bomb.
      if (best === 0) {
        const open = openPassable(state);
        let cut = 0;
        for (const p of state.players) {
          if (p.slot === slot || p.team === myTeam) continue;
          if (!p.alive || p.trapped) continue;
          const ex = tileOf(p.posX);
          const ey = tileOf(p.posY);
          if (blast.has(idx(ex, ey))) continue; // direct hit handled above.
          if (this.foeHasAllyAdjacent(state, p.slot, p.team, ex, ey)) continue;
          const man = Math.abs(ex - cand.rx) + Math.abs(ey - cand.ry);
          if (man > fire + 1) continue; // only a foe the blast can plausibly box in.
          // Of the foe's currently-safe OPEN escape neighbours, how many does this
          // blast cover (turn lethal)? More covered ⇒ tighter cornering.
          let covered = 0;
          for (const d of DIRECTION_ORDER) {
            const nx = ex + dirDX(d);
            const ny = ey + dirDY(d);
            if (!inBounds(nx, ny) || !open(nx, ny)) continue;
            const e = danger.earliestLethal(idx(nx, ny));
            const safeNbr = e === undefined || e > STEP_DANGER_HORIZON;
            if (safeNbr && blast.has(idx(nx, ny))) covered += 1;
          }
          const v = Math.min(covered, CUTOFF_CAP);
          if (v > cut) cut = v;
        }
        best = cut;
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
   * economyValue(a). PLACE_BOMB → soft bricks destroyed (the farming reward).
   * MOVE/STAY → 0.
   *
   * v3 CHANGE: the old v2 item-proximity term (reward MOVE/STAY by integer
   * MANHATTAN distance to the nearest item) is REMOVED. Manhattan ignores walls,
   * so an item the bot could SEE but only reach by a detour (or not at all) became
   * a permanent HOVER-MAGNET: standing "closest by Manhattan" out-scored bombing
   * bricks while every actual step increased the Manhattan distance, so the bot
   * froze next to unreachable items and barely farmed (the v2 farm-stall — the
   * single biggest reason both versions only collected ~2 items per match). Item
   * navigation is already handled correctly by the BFS growth pull (itemDir/
   * itemDist over open reachability in sample()), which homes in on items the bot
   * can actually collect. Dropping the redundant, wall-blind term unfroze farming
   * (bombs placed per match ~7→~19, bricks cleared ~16→~35). Bomb-brick econ is
   * unchanged.
   */
  private economyValue(state: SimState, cand: Candidate, fire: number): number {
    if (cand.bomb) {
      return this.softDestroyedAt(state, cand.rx, cand.ry, fire);
    }
    return 0;
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
    // Progress, in "upgrade points", from spawn toward the target. The CANNON
    // target is per-map (this.curDevTargetCannon): classic drives it to the full
    // max so the bot keeps farming to a cannon SURPLUS — the fuel for offensive
    // multi-bomb corner seals — instead of declaring itself "developed" at cannon 3.
    const targetCannon = this.curDevTargetCannon;
    const targetFire = this.curDevTargetFire;
    const targetSpan =
      targetFire -
      PLAYER_START_FIRE +
      (targetCannon - PLAYER_START_CANNON);
    if (targetSpan <= 0) return 0;
    const got =
      Math.max(0, Math.min(targetFire, fire) - PLAYER_START_FIRE) +
      Math.max(0, Math.min(targetCannon, cannon) - PLAYER_START_CANNON);
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
    // v5: when true, do NOT stop at the first (nearest) valid refuge — scan ALL
    // valid refuges within maxEscapeLen and return the one with the MOST escape
    // branches (tie → nearest, then BFS order). The cheap boolean gate keeps the
    // default (false) fast path = first valid refuge, byte-identical to v4. The
    // EMIT / multi-bomb COMMIT paths pass true so the bot RUNS to a refuge that is
    // not itself a dead-end — fixing the "flee a bomb straight into a single-exit
    // pocket and get sealed by a follow-up" failure the diagnostic isolated. Only
    // the once-per-bomb commit pays the per-candidate escapeBranches cost.
    preferRobust = false,
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
    let best: readonly [number, number] | null = null;
    let bestBranches = -1;
    let bestDist = Number.MAX_SAFE_INTEGER;
    // CORRIDOR GATE (classic): is an attackable foe within combat reach? Manhattan,
    // cannon-INDEPENDENT — the seal threat is the imminent follow-up bomb, and
    // mid-vChain the foe has no free cannon (so nearestEnemyHyps would miss it).
    let corridorGateActive = false;
    if (this.curCorridorGate) {
      for (const p of state.players) {
        if (p.slot === slot || p.team === myTeam || !p.alive || p.trapped) continue;
        if (
          Math.abs(tileOf(p.posX) - myX) + Math.abs(tileOf(p.posY) - myY) <=
          foeReachTiles
        ) {
          corridorGateActive = true;
          break;
        }
      }
    }
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
          // escapeBranches is needed by the corridor gate AND robust selection;
          // compute it once when either applies (else keep the v4 fast path).
          const br =
            corridorGateActive || preferRobust
              ? this.escapeBranches(state, dangerPessimistic, cx, cy)
              : -1;
          // CORRIDOR GATE: with a foe near, a single-exit corridor refuge can be
          // capped by a follow-up seal bomb (the trapper vChain death v5-trace
          // showed) — reject it; require a junction (>= ENTRAP_BRANCH_TARGET).
          if (corridorGateActive && br < ENTRAP_BRANCH_TARGET) {
            // skip this refuge — keep searching for a junction within maxEscapeLen.
          } else if (!preferRobust) {
            return [cx, cy];
          } else {
            // Robust selection: most escape branches wins, nearest breaks the tie.
            // Enabled PER-MAP (classic only). On the CLOSED classic map this is a
            // pure win (BT +49->+62 over v4, direct mirror 52.5%->55.6%): escaping a
            // bomb to a junction instead of the nearest dead-end stops the follow-up
            // seal. On the OPEN pirate map it is OFF: chasing a far high-branch refuge
            // there bleeds farming tempo vs the v3 dev-racers (pirate BT 1809->1766)
            // and tempo-bounding it collapsed the mirror (45%) — the open-map mirror
            // edge and the v3-pool dev race are coupled, so pirate keeps the
            // nearest-refuge fast path and wins the ladder via the entrap term alone.
            if (br > bestBranches || (br === bestBranches && dist < bestDist)) {
              best = [cx, cy];
              bestBranches = br;
              bestDist = dist;
            }
          }
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
    return best;
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
      // No free cannon ⇒ cannot place a NEW pressure bomb (its live bombs are
      // already in the baseline danger map) — see scenarios.ts. Lets the bot close
      // during the foe's cooldown instead of treating it as always-able-to-bomb.
      if (p.activeBombs >= p.cannon) continue;
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
    protectLead: boolean,
    foeTileIdx: number,
    urgency: number,
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
    const econBoost = Math.floor((this.curEconBoostMax * effDevFactor) / 100);
    // KILL DOCTRINE: economy + growth (the farming terms) FADE with clock urgency
    // — a development lead is worthless under the new timeout=loss rule, so the
    // back of the match must be spent hunting, not farming. urgency 0 → full
    // farming (early dev untouched); 100 → farming silenced.
    // 獵殺流 Hunter (pureHunt) NEVER farms; otherwise farming fades with urgency.
    const farmScale = this.tuning.pureHunt ? 0 : 100 - urgency;
    const econ = Math.floor(
      (Math.floor((econRaw * (100 + econBoost)) / 100) * farmScale) / 100,
    );
    const growthScaled = Math.floor((growth * farmScale) / 100);
    const pos = this.positionValue(state, rx, ry);
    // KILL DOCTRINE: free-space SEAL — reward a bomb that compresses the foe's
    // refuge toward 0 (the actual kill mechanism vs a deterministic survivor).
    const seal = this.sealValue(state, slot, myTeam, cand, fire, danger);
    // FOE-DISTANCE axis — archetype-dependent (Runner flees, Zoner holds a ring,
    // everyone else hunts/approaches; protect-lead may back off early):
    let retreatScaled = 0;
    let huntScaled = 0;
    if (foeTileIdx >= 0) {
      const fx = foeTileIdx % MAP_COLS;
      const fy = (foeTileIdx - fx) / MAP_COLS;
      const man = Math.abs(rx - fx) + Math.abs(ry - fy);
      if (this.tuning.fleeFoe) {
        // 逃跑流 Runner: always maximize distance from the foe (strong, unfaded).
        retreatScaled = W_RETREAT * Math.min(man, RETREAT_CAP);
      } else if (this.curZoneStandoff > 0) {
        // 控場流 Zoner: hold a stand-off RING — reward tiles whose foe-distance is
        // nearest the ring radius (compress from there; never dive, never flee).
        // Radius is the per-map effective stand-off (classic tightens it to close
        // into kill range instead of mirroring at arm's length).
        huntScaled =
          W_HUNT * Math.max(0, HUNT_CAP - Math.abs(man - this.curZoneStandoff));
      } else {
        if (protectLead) {
          retreatScaled = Math.floor(
            (W_RETREAT * Math.min(man, RETREAT_CAP) * farmScale) / 100,
          );
        }
        // Hunt is ALWAYS at least partly on (camp near the foe to seal its escape
        // the moment it commits a bomb); pureHunt = always FULL strength.
        const approach = Math.max(0, HUNT_CAP - man);
        const huntFactor = this.tuning.pureHunt
          ? 100
          : Math.max(HUNT_FACTOR_FLOOR, urgency);
        huntScaled = Math.floor((W_HUNT * approach * huntFactor) / 100);
      }
    }
    // SUDDEN-DEATH SURVIVAL pull (v4-classic): as the shrink nears, reward tiles
    // that harden LATE (toward the surviving center) so the bot pre-positions to
    // outlast a near-peer who only reacts once the wall is already on it. Ramps in
    // over SHRINK_LEAD_TICKS before the shrink and holds at full after. Off when
    // the weight is 0 (pirate / non-classic). The hard refuge gate still governs
    // safety — this only biases WHICH safe tile to prefer.
    let shrinkScaled = 0;
    if (this.curShrinkWeight > 0) {
      const prox =
        state.tick <= SUDDEN_DEATH_START_TICK - SHRINK_LEAD_TICKS
          ? 0
          : Math.min(
              100,
              Math.floor(
                ((state.tick - (SUDDEN_DEATH_START_TICK - SHRINK_LEAD_TICKS)) *
                  100) /
                  SHRINK_LEAD_TICKS,
              ),
            );
      if (prox > 0) {
        shrinkScaled = Math.floor(
          (this.curShrinkWeight * SHRINK_SURVIVAL_RANK[idx(rx, ry)]! * prox) / 100,
        );
      }
    }
    // v5 ANTI-ENTRAPMENT penalty: while an attackable foe is within combat range,
    // penalise a result tile that is a dead-end / single-exit pocket (escapeBranches
    // < ENTRAP_BRANCH_TARGET), scaled by foe proximity. This keeps the bot at tiles
    // with redundant escape routes a single follow-up "seal" bomb cannot close —
    // directly countering both the player-observed deaths and the v3:trapper vChain.
    // It only re-weights WHICH safe tile is preferred; the hard refuge gate and the
    // survivability flood (W_SURVIVE, the dominant term) are untouched, so it can
    // never push the bot into a worse-surviving tile, only a more-escapable one.
    let entrapPenalty = 0;
    if (this.curEntrapWeight > 0 && foeTileIdx >= 0) {
      const fx = foeTileIdx % MAP_COLS;
      const fy = (foeTileIdx - fx) / MAP_COLS;
      const man = Math.abs(rx - fx) + Math.abs(ry - fy);
      const combatRange = this.tuning.combatRangeTiles ?? 5;
      // NB: the penalty fires on foe PROXIMITY alone, NOT on whether the foe has a
      // free cannon RIGHT NOW. A foe mid-vChain has its cannons spent placing the
      // seal (activeBombs≈cannon) at the very moment the seal is closing — gating
      // on "free cannon" measurably disabled the defense exactly when it matters
      // (trapper classic 61.7%→55.8% in the A/B). The threat is the IMMINENT seal,
      // so proximity is the right trigger.
      if (man <= combatRange) {
        const deficit = Math.max(
          0,
          ENTRAP_BRANCH_TARGET - this.escapeBranches(state, danger, rx, ry),
        );
        if (deficit > 0) {
          const prox = Math.max(0, combatRange + 1 - man); // closer foe → bigger.
          entrapPenalty = this.curEntrapWeight * deficit * prox;
        }
      }
    }
    return (
      W_RESCUE * rescue +
      wAttack * pressure +
      Math.floor((W_SEAL * seal * this.curSealMult) / 100) +
      W_ECON * econ +
      W_GROWTH * growthScaled +
      W_POSITION * pos +
      retreatScaled +
      huntScaled +
      shrinkScaled -
      entrapPenalty
    );
  }

  /**
   * MULTI-BOMB FARMING gate (v3). While retreating from a just-dropped bomb, may
   * we SAFELY drop ANOTHER productive bomb on the current tile to pack a brick
   * cluster (parallel farming with spare cannons)? Returns the validated refuge
   * to retreat to, or null. Conditions:
   *   - a spare cannon is free and no bomb already sits here;
   *   - the bomb here breaks ≥1 soft brick (productive);
   *   - NO attackable foe within profile.cautionDist open hops (pure farming
   *     context — never multi-bomb into a fight, where it could self-endanger);
   *   - it would not friendly-fire a teammate;
   *   - the SAME pessimistic refuge gate single bombs pass still finds a refuge —
   *     and since buildDangerMap includes every live bomb in state.bombs, that
   *     refuge is validated against ALL active bombs PLUS this new one, so it can
   *     never trap the bot. Pure / deterministic.
   */
  private tryMultiBombFarm(
    state: SimState,
    slot: number,
    myTeam: number,
    myX: number,
    myY: number,
    myPlayer: { activeBombs: number; cannon: number; fire: number },
    ticksPerTile: number,
    profile: MapProfile,
  ): readonly [number, number] | null {
    if (myPlayer.activeBombs >= myPlayer.cannon) return null;
    if (bombAt(state.bombs, myX, myY) !== undefined) return null;
    if (this.softDestroyedAt(state, myX, myY, myPlayer.fire) <= 0) return null;
    // Far-from-foe only: bail if any attackable foe is within cautionDist hops.
    const foes = this.foeTiles(state, slot, myTeam);
    if (foes.size > 0) {
      const hit = bfsFirstStep(
        state,
        myX,
        myY,
        (x, y) => foes.has(idx(x, y)),
        openPassable(state),
      );
      if (hit !== null && hit.dist < profile.cautionDist) return null;
    }
    if (this.bombHitsTeammate(state, slot, myTeam, myX, myY, myPlayer.fire)) {
      return null;
    }
    const foeReachTiles = this.tuning.combatRangeTiles ?? 5;
    return this.validateBombRefugePessimistic(
      state,
      slot,
      myTeam,
      myX,
      myY,
      myPlayer.fire,
      ticksPerTile,
      foeReachTiles,
      this.curRobustRefuge, // classic: commit to the MOST escapable refuge.
    );
  }

  /**
   * MULTI-BOMB ATTACK pincer (v3 MOONSHOT — forced-kill construction). While
   * retreating from a just-dropped bomb with a foe IN RANGE, if a spare cannon
   * lets us drop ANOTHER bomb on the current tile that further COMPRESSES that
   * foe's free space (sealValue > 0 — and sealValue's kill check is already
   * live-bomb-aware: it scores the foe's OPTIMAL flee against EVERY live bomb
   * plus this one, so a second bomb that covers the first bomb's escape shadow
   * reads as a genuine seal/kill), AND the SAME pessimistic refuge gate still
   * finds us an escape vs ALL live bombs PLUS this one, drop it. This builds the
   * 2-3 bomb pincer a single bomb-and-flee never can: the foe is herded into the
   * first bomb's shadow and sealed by the second. Self-gating (seal>0 needs a foe
   * in blast range), so it only ever fires in genuine close-quarters attack — far
   * from any foe it returns null and the farming pincer handles packing bricks.
   * Returns the validated refuge to retreat to, or null. Pure / deterministic.
   */
  private tryMultiBombAttack(
    state: SimState,
    slot: number,
    myTeam: number,
    myX: number,
    myY: number,
    myPlayer: { activeBombs: number; cannon: number; fire: number },
    ticksPerTile: number,
    danger: IntervalDanger,
  ): readonly [number, number] | null {
    if (myPlayer.activeBombs >= myPlayer.cannon) return null;
    if (bombAt(state.bombs, myX, myY) !== undefined) return null;
    if (this.bombHitsTeammate(state, slot, myTeam, myX, myY, myPlayer.fire)) {
      return null;
    }
    // Productive ATTACK only: the bomb must compress some foe (seal>0). This both
    // self-gates to close quarters and avoids wasting a cannon on a no-op bomb.
    const cand: Candidate = {
      dir: Direction.NONE as number,
      bomb: true,
      rx: myX,
      ry: myY,
      score: 0,
      survSafe: true,
      refugeX: -1,
      refugeY: -1,
    };
    if (this.sealValue(state, slot, myTeam, cand, myPlayer.fire, danger) <= 0) {
      return null;
    }
    const foeReachTiles = this.tuning.combatRangeTiles ?? 5;
    return this.validateBombRefugePessimistic(
      state,
      slot,
      myTeam,
      myX,
      myY,
      myPlayer.fire,
      ticksPerTile,
      foeReachTiles,
      this.curRobustRefuge, // classic: commit to the MOST escapable refuge.
    );
  }

  /**
   * MOONSHOT — decisive FINISHING MOVE. Each decision tick, before the general
   * scoring, look for a CONFIRMED kill: a bomb (on our tile, or one safe step
   * away) whose blast — combined with EVERY live bomb already on the field (our
   * earlier pincer bomb, the foe's own bomb) — drives the foe's fuse-aware
   * survivability to a doomed pocket (≤ FOE_DOOM_THRESHOLD). The foe's optimal
   * flee is modelled by the same `survivability` flood the bot trusts for itself,
   * so a "confirmed" kill means the foe genuinely cannot escape over the real
   * detonation timeline. Returns the bomb / the step toward the kill tile, or null
   * if no confirmed kill exists. This guarantees the bot never lets the depth
   * search out-vote a real finish (the single biggest cause of "compresses the foe
   * to a seal every game but converts almost none"). Pure / deterministic.
   */
  private tryFinishingMove(
    state: SimState,
    slot: number,
    myTeam: number,
    myX: number,
    myY: number,
    myPlayer: { activeBombs: number; cannon: number; fire: number },
    tpt: number,
    safeInterval: Passable,
    foeTileIdx: number,
  ): InputFrame | null {
    if (foeTileIdx < 0) return null;
    if (myPlayer.activeBombs >= myPlayer.cannon) return null; // no bomb to throw.
    const fx = foeTileIdx % MAP_COLS;
    const fy = (foeTileIdx - fx) / MAP_COLS;
    const combatRange = this.tuning.combatRangeTiles ?? 5;
    // Only near the foe (cheap gate; the blast must be able to reach it anyway).
    if (Math.abs(myX - fx) + Math.abs(myY - fy) > combatRange + 2) return null;
    // Does a bomb at (bx,by) with our fire CONFIRM a kill? (friendly-fire-safe,
    // refuge-gated for US, and the foe's survivability vs all live bombs + this
    // one collapses to a doomed pocket.)
    const confirmsKill = (bx: number, by: number): boolean => {
      if (bombAt(state.bombs, bx, by) !== undefined) return false;
      if (this.bombHitsTeammate(state, slot, myTeam, bx, by, myPlayer.fire)) {
        return false;
      }
      if (
        !this.computeBombGateOk(
          state, slot, myTeam, bx, by, myPlayer.fire, tpt, combatRange,
        )
      ) {
        return false;
      }
      const hyp = hypotheticalBomb(bx, by, myPlayer.fire, slot);
      const d = buildDangerMap(state, [hyp]);
      return this.survivability(state, d, fx, fy) <= FOE_DOOM_THRESHOLD;
    };
    // 1) Bomb our CURRENT tile if that confirms the kill (the finisher itself).
    if (confirmsKill(myX, myY)) {
      return { dir: Direction.NONE as number, action: ActionFlags.BOMB };
    }
    // 2) A safe ADJACENT tile from which a bomb confirms the kill → step there
    // (we finish next tick). Fixed DIRECTION_ORDER → deterministic first match.
    for (const dd of DIRECTION_ORDER) {
      const nx = myX + dirDX(dd);
      const ny = myY + dirDY(dd);
      if (!inBounds(nx, ny) || !safeInterval(nx, ny)) continue;
      if (confirmsKill(nx, ny)) {
        this.commit(dd);
        return { dir: dd, action: ActionFlags.NONE };
      }
    }
    return null;
  }

  /**
   * MINIMAX FORCED-TRAP (the moonshot core: the search MODELS the opponent's
   * forced response). For a bomb B1 on our current tile, compute the foe's FORCED
   * refuge R1 — the survival-maximising tiles it can still safely reach once B1 is
   * down (its best replies). If R1 is small enough to seal (a cornered foe, i.e.
   * a closed-map corridor; an open map gives a large R1 and we skip), look for a
   * SECOND bomb B2 on a reachable tile such that the foe is doomed from EVERY tile
   * in R1 (its best response still dies — a genuine forced kill, fuse-aware via
   * the interval danger model). If found, COMMIT B1 now; the pincer / finishing
   * move place B2 over the next ticks. Returns the bomb action or null. Cost-
   * bounded (B1 = current tile only; runs only when a foe is close). Pure.
   */
  private tryForcedTrap(
    state: SimState,
    slot: number,
    myTeam: number,
    myX: number,
    myY: number,
    myPlayer: { activeBombs: number; cannon: number; fire: number },
    tpt: number,
    safeInterval: Passable,
    foeTileIdx: number,
  ): InputFrame | null {
    if (foeTileIdx < 0) return null;
    if (myPlayer.activeBombs >= myPlayer.cannon) return null; // no bomb to start with.
    const fx = foeTileIdx % MAP_COLS;
    const fy = (foeTileIdx - fx) / MAP_COLS;
    const combatRange = this.tuning.combatRangeTiles ?? 5;
    if (Math.abs(myX - fx) + Math.abs(myY - fy) > combatRange + 2) return null;
    // B1 on our current tile must be friendly-fire-safe and leave US an escape.
    if (bombAt(state.bombs, myX, myY) !== undefined) return null;
    if (this.bombHitsTeammate(state, slot, myTeam, myX, myY, myPlayer.fire)) {
      return null;
    }
    if (
      !this.computeBombGateOk(
        state, slot, myTeam, myX, myY, myPlayer.fire, tpt, combatRange,
      )
    ) {
      return null;
    }
    const hyp1 = hypotheticalBomb(myX, myY, myPlayer.fire, slot);
    const d1 = buildDangerMap(state, [hyp1]);
    const r1 = this.foeSafeSet(state, d1, [idx(fx, fy)], TRAP_SET_CAP);
    if (r1.length === 0) {
      return { dir: Direction.NONE as number, action: ActionFlags.BOMB }; // B1 alone kills.
    }
    if (r1.length > TRAP_R1_MAX) return null; // too open to force a seal.
    // Need a SECOND bomb to seal R1: a spare cannon beyond the one for B1.
    if (myPlayer.cannon - myPlayer.activeBombs < 2) return null;
    // Search a sealing B2 on a safe reachable neighbour: forced kill iff the foe,
    // from EVERY tile of its forced refuge R1, is doomed under B1+B2.
    for (const dd of DIRECTION_ORDER) {
      const b2x = myX + dirDX(dd);
      const b2y = myY + dirDY(dd);
      if (!inBounds(b2x, b2y) || !safeInterval(b2x, b2y)) continue;
      if (bombAt(state.bombs, b2x, b2y) !== undefined) continue;
      if (this.bombHitsTeammate(state, slot, myTeam, b2x, b2y, myPlayer.fire)) {
        continue;
      }
      const hyp2 = hypotheticalBomb(b2x, b2y, myPlayer.fire, slot);
      const d2 = buildDangerMap(state, [hyp1, hyp2]);
      let forced = true;
      for (const t of r1) {
        const tx = t % MAP_COLS;
        const ty = (t - tx) / MAP_COLS;
        if (this.survivability(state, d2, tx, ty) > FOE_DOOM_THRESHOLD) {
          forced = false;
          break;
        }
      }
      if (forced) {
        return { dir: Direction.NONE as number, action: ActionFlags.BOMB };
      }
    }
    return null;
  }

  /** This bot's InputFrame for this tick. MUTATES internal state. */
  sample(state: SimState, slot: number): InputFrame {
    void this.ctorSlot; // ctor slot is debug/seed only; `slot` wins.

    // Select the per-map profile once (lazily) and cache it for the match —
    // mapKind is a whole-match constant. Both profiles are NEUTRAL today so this
    // never changes a decision; it is the seam for a later per-map tuning pass.
    if (this.profile === null) this.profile = this.profileFor(state);
    const profile = this.profile;

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

    const tpt = this.ticksPerTile(state, myPlayer.speedBonusTenths);

    // ---- POST-BOMB ESCAPE OVERRIDE (runs FIRST, before scoring) ------------
    const escapeFrame = this.runEscape(state, myX, myY, gridDanger);
    if (escapeFrame !== null) {
      // MULTI-BOMB FARMING (v3): while retreating from a just-dropped bomb in a
      // SAFE farming context (no foe within cautionDist), if our CURRENT tile can
      // break more bricks AND a fresh refuge survives the pessimistic gate vs ALL
      // live bombs PLUS this new one, drop another bomb here and re-anchor the
      // retreat to that refuge. This packs a whole soft-brick cluster with bombs
      // (using spare cannons) instead of one-bomb-then-flee, ~doubling farming
      // throughput on the closed map. The gate is the SAME one single bombs pass,
      // so it can never self-trap; gated to far-from-foe so it only farms.
      // MOONSHOT: the ATTACK pincer (stack a sealing bomb on a foe in range) takes
      // priority over the farming pincer — building a forced kill beats packing
      // bricks. Both re-validate the bot's own escape vs all live bombs + the new
      // one, so neither can self-trap.
      const attackRefuge =
        this.tuning.fleeFoe || this.tuning.noise || this.tuning.mirror
          ? null
          : this.tryMultiBombAttack(state, slot, myTeam, myX, myY, myPlayer, tpt, danger);
      const farmRefuge =
        attackRefuge !== null
          ? attackRefuge
          : profile.multiBombFarm
            ? this.tryMultiBombFarm(state, slot, myTeam, myX, myY, myPlayer, tpt, profile)
            : null;
      if (farmRefuge !== null) {
        this.threatPending = myDangerEarliest !== undefined;
        this.reactionTimer = 0;
        this.committedDir = Direction.NONE as number;
        this.committedTicks = 0;
        this.escapeTargetX = farmRefuge[0];
        this.escapeTargetY = farmRefuge[1];
        this.escapeTicks = 0;
        return { dir: Direction.NONE, action: ActionFlags.BOMB };
      }
      this.threatPending = myDangerEarliest !== undefined;
      this.reactionTimer = 0;
      this.committedDir = Direction.NONE as number;
      this.committedTicks = 0;
      return escapeFrame;
    }

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

    // KILL DOCTRINE clock urgency (0..100): 0 until profile.huntStartTick (develop a trap
    // kit at full economy), then ramps linearly to 100 at the tick cap. Fades the
    // farming terms, scales up the hunt pull, and loosens the close-quarters
    // survivability CLAMP (never the refuge gate) so a compressing bomb can win.
    // Resolve the effective Zoner ring radius for this decision: per-map override
    // when set (>0), else the archetype's own knob. Read by leafReward below.
    this.curZoneStandoff =
      profile.zoneStandoffTiles > 0
        ? profile.zoneStandoffTiles
        : (this.tuning.zoneStandoff ?? 0);
    this.curShrinkWeight = profile.shrinkSurvivalWeight;
    this.curDevTargetCannon = profile.devTargetCannon;
    this.curDevTargetFire = profile.devTargetFire;
    this.curCornerFinish = profile.cornerFinish;
    this.curEconBoostMax = profile.devEconBoostMax;
    this.curSealMult = profile.sealWeightMult;
    this.curEntrapWeight = profile.entrapWeight;
    this.curRobustRefuge = profile.robustRefuge;
    this.curCorridorGate = profile.corridorGate;

    const huntStart = profile.huntStartTick;
    const urgency =
      state.tick <= huntStart
        ? 0
        : Math.min(
            100,
            Math.floor(
              ((state.tick - huntStart) * 100) / (T_HUNT_FULL - huntStart),
            ),
          );

    // Nearest attackable-foe BFS distance over open passability, computed ONCE
    // here (capped 40, 40 when no foe). It feeds BOTH the close-quarters engage
    // override below AND aggressionWeight's proxFactor (passed in), so the two
    // stay in sync. Logic is byte-identical to the version formerly inside
    // aggressionWeight (same foeTiles, same bfsFirstStep, same cap 40).
    const foeTilesNow = this.foeTiles(state, slot, myTeam);
    let foeDist = 40;
    let nearestFoeTileIdx = -1;
    if (foeTilesNow.size > 0) {
      const foeHit = bfsFirstStep(
        state,
        myX,
        myY,
        (x, y) => foeTilesNow.has(idx(x, y)),
        openPassable(state),
      );
      if (foeHit !== null) {
        foeDist = Math.min(40, foeHit.dist);
        nearestFoeTileIdx = idx(foeHit.target[0], foeHit.target[1]);
      }
    }

    // CORNER-FINISH (v4-classic): if the nearest foe is in reach AND genuinely
    // cornered (its free space has collapsed to <= CORNER_FREE_THRESHOLD), drop
    // the Zoner stand-off ring to 1 so the bot dives in to SEAL it with the
    // multi-bomb pincer instead of orbiting at arm's length while the foe slips
    // out. The hard refuge gate still governs our own safety. Classic-only.
    if (
      this.curCornerFinish &&
      this.curZoneStandoff > 1 &&
      nearestFoeTileIdx >= 0 &&
      foeDist <= (this.tuning.combatRangeTiles ?? 5)
    ) {
      const ffx = nearestFoeTileIdx % MAP_COLS;
      const ffy = (nearestFoeTileIdx - ffx) / MAP_COLS;
      if (this.foeFreeSpace(state, danger, ffx, ffy, null) <= CORNER_FREE_THRESHOLD) {
        this.curZoneStandoff = 1;
      }
    }

    // 隨機擾動 Noise (out-of-pool floor) + 反應流 Reactive (counter-puncher) are
    // SHORT-CIRCUIT controllers: they reuse the survival-first net / escape
    // override that already ran above (so they don't suicide), then REPLACE the
    // strategic forward search with their own simple rule. Placed here so both
    // see the nearest-foe tile.
    if (this.tuning.noise || this.tuning.mirror) {
      const foeReachTiles = this.tuning.combatRangeTiles ?? 5;
      if (this.tuning.noise) {
        // Weighted-random legal move; occasionally an ESCAPABLE bomb (gate-checked
        // so it never self-traps). Pure anti-suicide rationality only.
        if (
          this.randFloat() < this.tuning.bombChance &&
          myPlayer.activeBombs < myPlayer.cannon &&
          bombAt(state.bombs, myX, myY) === undefined &&
          !this.bombHitsTeammate(state, slot, myTeam, myX, myY, myPlayer.fire) &&
          this.computeBombGateOk(state, slot, myTeam, myX, myY, myPlayer.fire, tpt, foeReachTiles)
        ) {
          return { dir: Direction.NONE, action: ActionFlags.BOMB };
        }
        const d = this.randomSafeDir(myX, myY, safeOpenInterval);
        this.commit(d);
        return { dir: d, action: ActionFlags.NONE };
      }
      // Reactive (mirror): shadow the foe's last move + pounce on its bombs.
      return this.reactiveAction(
        state, slot, myTeam, myX, myY, myPlayer, tpt, foeReachTiles,
        safeOpenInterval, nearestFoeTileIdx,
      );
    }

    // MOONSHOT: take any CONFIRMED kill decisively (a fighting archetype never
    // lets the depth search out-vote a real finish). Runner (fleeFoe) abstains —
    // it wins only by survival, by design.
    if (!this.tuning.fleeFoe) {
      const finish = this.tryFinishingMove(
        state, slot, myTeam, myX, myY, myPlayer, tpt, safeOpenInterval, nearestFoeTileIdx,
      );
      if (finish !== null) return finish;
      // MINIMAX: if no immediate kill, look for a 2-bomb FORCED kill (model the
      // foe's best response) and commit the first bomb to start it.
      const trap = this.tryForcedTrap(
        state, slot, myTeam, myX, myY, myPlayer, tpt, safeOpenInterval, nearestFoeTileIdx,
      );
      if (trap !== null) return trap;
    }

    // PROTECT-THE-LEAD (v3, classic): when CONNECTED to a foe (foeDist <
    // cautionDist) and we are AHEAD on total pickups, the leaf reward adds a pull
    // AWAY from that foe so we don't get cornered/killed sitting on a winning
    // development lead (an aggressive engage loses to v2's wall-off on classic —
    // the winning play is out-develop then DON'T die). Pickup score is fire +
    // cannon + speed-items; start offsets cancel in the my-vs-foe comparison, so
    // raw stats suffice. Uses full information (the foe's exact stats are visible).
    const myPickups =
      myPlayer.fire + myPlayer.cannon + Math.trunc(myPlayer.speedBonusTenths / 4);
    let nearestFoePickups = 0;
    if (nearestFoeTileIdx >= 0) {
      for (const p of state.players) {
        if (p.slot === slot || p.team === myTeam || !p.alive || p.trapped) continue;
        if (idx(tileOf(p.posX), tileOf(p.posY)) === nearestFoeTileIdx) {
          nearestFoePickups =
            p.fire + p.cannon + Math.trunc(p.speedBonusTenths / 4);
          break;
        }
      }
    }
    const protectLead =
      profile.protectLead &&
      foeDist < PROTECT_LEAD_DIST &&
      nearestFoeTileIdx >= 0 &&
      myPickups > nearestFoePickups;

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
    // CONNECTIVITY DOCTRINE (v3): foeDist hit the cap ⇒ no OPEN path to any live
    // foe ⇒ isolated / pre-connection ⇒ combat impossible ⇒ farm to completion.
    // Force the effective development factor to at least the profile floor so the
    // econ boost + growth pull stay at full strength (v2 tapered them at mid-dev).
    // The instant an open path to a foe exists (foeDist < cap) we drop back to the
    // v2 readiness model. The survival-first safety net and the bomb-refuge gate
    // are NOT affected. When growUntilConnected is false (a neutral profile) or a
    // foe is close-quarters engaged, this is byte-identical to v2.
    const isolated = profile.growUntilConnected && foeDist >= ISOLATED_FOE_DIST;
    // KILL DOCTRINE: the isolated farm-to-completion floor FADES with urgency —
    // late in the match, stop farming the corner to a timeout loss; let real
    // readiness govern (so the bot digs toward / hunts the foe instead).
    const isolatedFloor = Math.floor((profile.isolatedDevFloor * (100 - urgency)) / 100);
    // 獵殺流 Hunter (pureHunt): never farm — force full readiness so econ boost /
    // growth pull are off and attack is uncut, every tick, regardless of dev.
    const effDevFactor = this.tuning.pureHunt
      ? 0
      : foeEngaged
        ? 0
        : isolated
          ? Math.max(devFactor, isolatedFloor)
          : devFactor;

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
    // v3 ITEM PRIORITY: prefer items that ACCELERATE the development race —
    // CANNON (more simultaneous bombs → faster farming) and SPEED (less idle) —
    // over FIRE, which has sharply diminishing value and, on the tight classic
    // lattice, makes a bomb's big cross HARD TO ESCAPE (gate rejects it → farming
    // stalls). Every pickup counts the SAME for the tick-cap item tiebreak, so
    // steering development toward cannon/speed both farms faster AND scores the
    // same. Target score = kindPriority*3 − hop distance (so a modestly-closer
    // lower-priority item can still win); fire is further de-emphasised once we
    // already hold a mid fire level (>= DEV_TARGET_FIRE). Deterministic: fixed
    // array order, strict `>`, first wins ties.
    let bestItemScore = Number.NEGATIVE_INFINITY;
    for (const it of state.items) {
      const info = reachable.get(idx(it.tileX, it.tileY));
      if (info === undefined || info.dist === 0) continue;
      const pri =
        it.kind === ItemKind.CANNON
          ? 3
          : it.kind === ItemKind.SPEED
            ? 3
            : myPlayer.fire >= this.curDevTargetFire
              ? 1
              : 2; // FIRE
      const sc = pri * 3 - info.dist;
      if (sc > bestItemScore) {
        bestItemScore = sc;
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

    // ---- DEADLOCK GROWTH RELEASE (per-map knob; NEUTRAL == HEAD) -----------
    // An in-place bomb (inPlaceBricks > 0) normally SUPPRESSES the growth /
    // reposition pull (growthValue returns 0 when there are bricks to bomb right
    // here). On the closed CLASSIC spawn L-pocket a fire-2 bomb covers every
    // reachable tile → the safety gate REJECTS it → yet the suppression still
    // froze the bot (it could neither bomb nor be pulled to reposition). When
    // profile.deadlockGrowthRelease is true, an in-place bomb that is NOT
    // safely escapable (gate fails) no longer suppresses growth: treat
    // inPlaceBricksForGrowth as 0 so the bot is pulled one tile over to a spot
    // from which the SAME bricks ARE safely bombable. With the flag FALSE
    // (neutral, today) we never even probe the gate and pass inPlaceBricks
    // through verbatim → byte-identical to committed v2.
    const inPlaceBricksForGrowth =
      profile.deadlockGrowthRelease &&
      inPlaceBricks > 0 &&
      !this.computeBombGateOk(
        state,
        slot,
        myTeam,
        myX,
        myY,
        myPlayer.fire,
        tpt,
        foeReachTiles,
      )
        ? 0
        : inPlaceBricks;

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
            inPlaceBricksForGrowth,
            protectLead,
            nearestFoeTileIdx,
            urgency,
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
      // Per-map search knobs from the active profile. Survivability clamp is
      // PROXIMITY-gated, not binary-connection-gated: whenever the nearest foe is
      // far (>= CAUTION_DIST hops — the whole isolated farming phase AND a
      // connected-but-distant foe) use the low `isolatedSurvEnough` clamp so a
      // gate-approved bomb's small surv dip never vetoes farming; only when a foe
      // is genuinely CLOSE (< CAUTION_DIST) revert to full `survEnough` caution —
      // exactly where v3 was dying to wall-offs. (foeDist is capped at 40, so the
      // isolated case naturally falls in the "far" branch.)
      {
        deferredBombDiscountPct: profile.deferredBombDiscountPct,
        stayPenalty: profile.stayPenalty,
        // KILL DOCTRINE: the close-quarters caution (full survEnough) LOOSENS with
        // urgency. The hard refuge GATE is untouched (a bomb still needs an escape
        // — no self-trap), but the survivability MAGNITUDE clamp drops from full
        // (early) toward HUNT_SURV_FLOOR (late), so among gate-passed actions a
        // foe-compressing bomb is no longer out-voted by squeezing out one more
        // tick of the bot's own already-safe breathing room. Far from any foe the
        // farming clamp (isolatedSurvEnough) is unchanged.
        // 獵殺流 Hunter (pureHunt) accepts risk ALWAYS (clamp at the floor); other
        // archetypes loosen the close-quarters clamp only as urgency rises.
        survEnough:
          foeDist < profile.cautionDist
            ? this.tuning.pureHunt
              ? HUNT_SURV_FLOOR
              : urgency === 0
                ? profile.survEnough
                : Math.max(HUNT_SURV_FLOOR, 28 - Math.floor((urgency * 24) / 100))
            : profile.isolatedSurvEnough,
      } satisfies SearchKnobs,
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
    // FARMING CADENCE (profile.farmCadence; pirate on, classic off). `inPlaceBricks`
    // = soft bricks an in-place bomb breaks right now; `foeEngaged`/`scenarios` are
    // in scope above. Gated on farming context (not pureHunt, no foe engaged) so
    // combat behaviour is untouched.
    const farming =
      profile.farmCadence &&
      bestAction === RootAction.PLACE_BOMB &&
      !this.tuning.pureHunt &&
      !foeEngaged;
    const spareCannon =
      myPlayer.activeBombs < myPlayer.cannon &&
      bombAt(state.bombs, myX, myY) === undefined;
    // H2 pre-place: a productive farming bomb with a spare cannon bypasses the
    // bombChance throttle (place it now, keep the cadence going).
    const productiveFarmBomb = farming && inPlaceBricks > 0 && spareCannon;
    // bombChance throttle (POST-search): if the search wants to bomb but a
    // bombChance roll fails, downgrade to the best non-bomb root action.
    if (bestAction === RootAction.PLACE_BOMB && !productiveFarmBomb) {
      if (this.randFloat() >= this.tuning.bombChance) {
        bestAction = this.bestNonBombAction(perAction);
      }
    }
    // H1 no-waste: drop a wasteful farming bomb (no bricks AND hits no foe).
    if (farming && bestAction === RootAction.PLACE_BOMB && inPlaceBricks === 0) {
      const bombHitsFoe =
        this.enemyPressure(
          state,
          slot,
          myTeam,
          {
            dir: Direction.NONE,
            bomb: true,
            rx: myX,
            ry: myY,
            score: 0,
            survSafe: true,
            refugeX: -1,
            refugeY: -1,
          },
          myPlayer.fire,
          scenarios[0]!,
        ) > 0;
      if (!bombHitsFoe) bestAction = this.bestNonBombAction(perAction);
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
              this.curRobustRefuge, // classic: commit to the MOST escapable refuge.
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
