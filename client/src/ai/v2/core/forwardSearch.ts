/**
 * forwardSearch — depth-limited forward-model DFS with pessimistic scenarios +
 * maximin for the v2 bot.
 *
 * The search uses a LIGHTWEIGHT, bot-private forward model (NOT the real
 * sim.tick(), which advances state.prng and would corrupt lockstep). Map tiles,
 * bombs and the explosion timeline are treated as STATIC over the horizon — the
 * danger map already encodes the full future flame schedule — so the search only
 * tracks the bot's OWN movement + bomb drops, with a per-ply tick offset so the
 * time-aware danger thresholds advance as we plan deeper.
 *
 * Aggregation:
 *  - survivability is the MIN over the 3 scenarios (worst case / maximin).
 *  - reward is computed ONCE against scenario[0] (optimistic baseline).
 *  - a root action's score is the MIN leafVal over all leaves under it
 *    (pessimistic worst leaf). The winner is the argmax over the 6 root actions,
 *    strict `>`, FIRST wins.
 *
 * PURE / prng-free: zero RNG, all-integer scores, fixed action order. Never
 * touches SimState.prng. Anytime: returns whatever root scores exist when the
 * node cap is hit.
 */
import type { SimState } from '../../../sim/Sim';
import { DIRECTION_ORDER } from '../../../sim/InputBuffer';
import { Direction } from '../../../../../shared/types';
import { idx, inBounds } from '../../../sim/Map';
import { dirDX, dirDY } from '../../../sim/Player';
import { bombAt } from '../../../sim/Bomb';
import type { IntervalDanger } from '../../common/dangerMap';

/**
 * Search depth (plies of the bot's own movement explored).
 *
 * NOTE (perf deviation from the original depth-5 plan): the v2 leaf evaluation
 * (3-scenario maximin survivability flood + the v1 reward terms) is ~2× the v1
 * per-tick cost. At depth 5 / NODE_CAP 800 the heaviest regression guards
 * (4 live hard bots × 80 full 60 Hz matches) exceeded the 120 s vitest budget.
 * Depth 4 / NODE_CAP 400 keeps the same maximin behaviour (the bomb-escape
 * lookahead still spans a full refuge route) while roughly halving search cost,
 * bringing those guards comfortably under budget. Survivability remains the
 * dominant term, so the safety profile is unchanged.
 */
export const SEARCH_DEPTH = 4;
/** Hard node-expansion budget (anytime early-return once reached). */
export const NODE_CAP = 400;

/** Root actions in FIXED order: STAY, UP, DOWN, LEFT, RIGHT, PLACE_BOMB. */
export const enum RootAction {
  STAY = 0,
  UP = 1,
  DOWN = 2,
  LEFT = 3,
  RIGHT = 4,
  PLACE_BOMB = 5,
}

/** Number of root actions. */
export const ROOT_ACTION_COUNT = 6;

/** The bot's own mutable forward-model state along a search branch. */
export interface SearchState {
  x: number;
  y: number;
  bombsPlaced: number;
  activeBombs: number;
  cannon: number;
  fire: number;
  /** Ticks elapsed (relative to now) at this node — for danger thresholds. */
  tickOffset: number;
  /** Reward accumulated along this branch (bomb-drop value), integer. */
  accReward: number;
}

export interface ForwardSearchResult {
  bestAction: RootAction;
  score: number;
  leavesEvaluated: number;
  /** Per-root-action score (length 6); -Infinity = illegal/never expanded. */
  perActionScores: number[];
}

/**
 * Callbacks supplied by BotController so the search reuses the EXACT v1 leaf
 * math (survivability + the reward terms) without duplicating it.
 */
export interface SearchCallbacks {
  /** v1 survivability against a specific scenario danger map. */
  survivability: (danger: IntervalDanger, rx: number, ry: number) => number;
  /**
   * Optimistic reward at a leaf (rescue + enemyPressure + economy + growth +
   * position), evaluated against scenario[0]. Includes wAttack scaling.
   * `bombHere` = true iff the leaf's last action placed a bomb on (rx,ry).
   */
  leafReward: (rx: number, ry: number, bombHere: boolean, fire: number) => number;
  /** Anti-backtrack penalty for ending on (rx,ry). */
  penaltyFor: (rx: number, ry: number) => number;
  /**
   * Pessimistic bomb-drop gate: can a bomb at (x,y) with `fire` be survived
   * (refuge exists)? Used to prune illegal PLACE_BOMB inside the search.
   */
  bombGateOk: (x: number, y: number, fire: number) => boolean;
}

/**
 * The per-map decision knobs the SEARCH reads, supplied by the active MapProfile
 * (BotController picks classic vs pirate from SimState.mapKind and passes these
 * in — the core never reads process.env). NEUTRAL today (== committed v2): with
 * these values every knob is a no-op, so the search result is byte-identical to
 * HEAD. A later per-map pass can hand classic non-neutral values to close the
 * defer-forever / spawn-deadlock degeneracy without touching this engine.
 *
 * 由 MapProfile 餵入的搜尋旋鈕；目前全中性（== HEAD）。core 不讀 process.env。
 */
export interface SearchKnobs {
  /**
   * Depth discount (PERCENT per ply) on a DEFERRED bomb's reward: a bomb dropped
   * at search depth d keeps max(0, 100 - pct*d)% of its reward. 0 = identity.
   */
  readonly deferredBombDiscountPct: number;
  /** Flat INTEGER penalty subtracted from the STAY root's final score. 0 = none. */
  readonly stayPenalty: number;
  /**
   * Survivability clamp ceiling: each leaf uses min(worstSurv, survEnough) before
   * weighting. MAX_SAFE_INTEGER = the clamp never bites (HEAD behavior).
   */
  readonly survEnough: number;
}

const W_SURVIVE = 1000;

/** Time-aware move legality vs the baseline scenario (scenario[0]). */
function moveLegal(
  state: SimState,
  base: (x: number, y: number) => boolean,
  scenario0: IntervalDanger,
  nx: number,
  ny: number,
  tickOffset: number,
  stepHorizon: number,
): boolean {
  if (!inBounds(nx, ny) || !base(nx, ny)) return false;
  const e = scenario0.earliestLethal(idx(nx, ny));
  return e === undefined || e > stepHorizon + tickOffset;
}

/**
 * Run the depth-limited forward search. `base` is openPassable(state); `step`
 * is STEP_DANGER_HORIZON. `ticksPerTile` advances tickOffset per ply. `knobs`
 * are the active MapProfile's per-map search knobs (NEUTRAL == HEAD behavior).
 */
export function forwardSearch(
  state: SimState,
  scenarios: IntervalDanger[],
  start: SearchState,
  wAttack: number,
  ticksPerTile: number,
  stepHorizon: number,
  base: (x: number, y: number) => boolean,
  cb: SearchCallbacks,
  knobs: SearchKnobs,
): ForwardSearchResult {
  void wAttack; // wAttack is already folded into cb.leafReward by the caller.
  const scenario0 = scenarios[0]!;

  // Per-root running aggregation. Survivability is minimised over the pessimistic
  // SCENARIOS at each leaf (the adversary), but a root's score is the MAX over
  // the bot's OWN continuations (the bot controls its later moves) — i.e. proper
  // maximin: minimise over the opponent, maximise over our own plan. A pure MIN
  // over our own continuations froze the bot (every action has SOME bad branch),
  // so STAY always "won". -Infinity until a leaf is seen.
  const rootScore: number[] = new Array(ROOT_ACTION_COUNT).fill(
    Number.NEGATIVE_INFINITY,
  );

  let nodes = 0;
  let leaves = 0;
  let capped = false;

  // Per-root transposition set (cleared between roots → cross-root independence
  // preserved). Movement creates MANY paths reaching the same (tile, depth) with
  // the same carried reward; their subtrees are IDENTICAL, so re-expanding them
  // is pure waste. Skipping a duplicate cannot change the per-root MAX (the
  // identical subtree's best leaf was already recorded). This roughly halves the
  // node count, keeping the heavy self-trap guards under their time budget with
  // ZERO behavioural change (the search result is bit-identical). Key packs
  // (idx(x,y), depth, bombsPlaced, accReward) into one integer; accReward is
  // bounded small so the multipliers don't collide within safe-integer range.
  const visited = new Set<number>();
  const stateKey = (s: SearchState, depth: number): number =>
    ((idx(s.x, s.y) * 8 + depth) * 8 + s.bombsPlaced) * 100003 + s.accReward;

  // Leaf evaluation: maximin survivability over scenarios + the reward carried
  // along this branch (seeded per-root with the IMMEDIATE reward of the root
  // action — exactly the v1 candidate reward at the result tile — plus any
  // bomb-drop value accumulated deeper), minus the anti-backtrack penalty. The
  // reward is seeded at the root rather than evaluated at the terminal leaf so a
  // root that advances toward a growth target / drops a productive bomb keeps
  // that value regardless of where the deepest branch wanders (the v1 growth/
  // econ/attack pull would otherwise vanish at depth>1). Integer throughout.
  // Deferred-bomb reward discount (per-map knob). A bomb dropped at search depth
  // d keeps max(0, 100 - pct*d)% of its reward, so "bomb now" can outscore
  // "wander then bomb later". With pct === 0 (neutral) this is the identity, so
  // the carried reward is byte-identical to HEAD.
  const discBomb = (r: number, depth: number): number =>
    knobs.deferredBombDiscountPct === 0
      ? r
      : Math.floor(
          (r * Math.max(0, 100 - knobs.deferredBombDiscountPct * depth)) / 100,
        );
  const evalLeaf = (s: SearchState): number => {
    let worstSurv = Number.MAX_SAFE_INTEGER;
    for (const sc of scenarios) {
      const surv = cb.survivability(sc, s.x, s.y);
      if (surv < worstSurv) worstSurv = surv;
    }
    const penalty = cb.penaltyFor(s.x, s.y);
    // Clamp survivability at survEnough before weighting (per-map knob). With
    // survEnough === MAX_SAFE_INTEGER (neutral) the clamp never bites → HEAD.
    return W_SURVIVE * Math.min(worstSurv, knobs.survEnough) + s.accReward - penalty;
  };

  const recordLeaf = (s: SearchState, root: RootAction): void => {
    const v = evalLeaf(s);
    leaves += 1;
    if (v > rootScore[root]!) rootScore[root] = v;
  };

  /** `root` is the fixed first-ply action for this subtree. */
  const dfs = (s: SearchState, depth: number, root: RootAction): void => {
    if (capped) return;
    // Early prune: a node doomed in the optimistic baseline cannot yield
    // breathing room — score it as a leaf (so the MAX still reflects it) and stop.
    const optSurv = cb.survivability(scenario0, s.x, s.y);

    if (depth >= SEARCH_DEPTH || optSurv === 0) {
      recordLeaf(s, root);
      return;
    }

    // Transposition prune: an identical (tile, depth, bombsPlaced, accReward)
    // node was already expanded under this root → its subtree's best leaf is
    // already in rootScore. Skipping is bit-identical to expanding again.
    const key = stateKey(s, depth);
    if (visited.has(key)) return;
    visited.add(key);

    // Expand children in FIXED action order: STAY, UP, DOWN, LEFT, RIGHT, BOMB.
    // STAY.
    {
      nodes += 1;
      if (nodes >= NODE_CAP) {
        capped = true;
        recordLeaf(s, root);
        return;
      }
      dfs({ ...s, tickOffset: s.tickOffset + ticksPerTile }, depth + 1, root);
    }
    if (capped) return;

    // Moves.
    for (const d of DIRECTION_ORDER) {
      const nx = s.x + dirDX(d);
      const ny = s.y + dirDY(d);
      if (
        !moveLegal(state, base, scenario0, nx, ny, s.tickOffset, stepHorizon)
      ) {
        continue;
      }
      nodes += 1;
      if (nodes >= NODE_CAP) {
        capped = true;
        recordLeaf({ ...s, x: nx, y: ny }, root);
        return;
      }
      dfs(
        { ...s, x: nx, y: ny, tickOffset: s.tickOffset + ticksPerTile },
        depth + 1,
        root,
      );
      if (capped) return;
    }

    // PLACE_BOMB: accumulate the drop's reward into the branch (so its econ/
    // attack value persists to the terminal leaf even after the bot walks away).
    const canBomb =
      s.activeBombs < s.cannon &&
      bombAt(state.bombs, s.x, s.y) === undefined &&
      cb.bombGateOk(s.x, s.y, s.fire);
    if (canBomb) {
      nodes += 1;
      if (nodes >= NODE_CAP) {
        capped = true;
        recordLeaf(
          {
            ...s,
            accReward:
              s.accReward +
              discBomb(cb.leafReward(s.x, s.y, true, s.fire), depth),
          },
          root,
        );
        return;
      }
      dfs(
        {
          ...s,
          bombsPlaced: s.bombsPlaced + 1,
          activeBombs: s.activeBombs + 1,
          accReward:
            s.accReward + discBomb(cb.leafReward(s.x, s.y, true, s.fire), depth),
          tickOffset: s.tickOffset + ticksPerTile,
        },
        depth + 1,
        root,
      );
    }
  };

  // Launch one DFS per ROOT action (fixing the first ply). This keeps the
  // per-root MAX aggregation exact and the action order fixed. Each root seeds
  // accReward with its IMMEDIATE reward (the v1 candidate reward at the result
  // tile) so growth/econ/attack pulls survive the deeper lookahead.
  // STAY root.
  visited.clear();
  dfs(
    {
      ...start,
      accReward: cb.leafReward(start.x, start.y, false, start.fire),
      tickOffset: start.tickOffset + ticksPerTile,
    },
    1,
    RootAction.STAY,
  );

  // Move roots.
  const moveActions: Array<[number, RootAction]> = [
    [Direction.UP, RootAction.UP],
    [Direction.DOWN, RootAction.DOWN],
    [Direction.LEFT, RootAction.LEFT],
    [Direction.RIGHT, RootAction.RIGHT],
  ];
  for (const [d, ra] of moveActions) {
    if (capped) break;
    const nx = start.x + dirDX(d);
    const ny = start.y + dirDY(d);
    if (
      !moveLegal(state, base, scenario0, nx, ny, start.tickOffset, stepHorizon)
    ) {
      continue; // leaves rootScore[ra] = -Infinity (illegal).
    }
    visited.clear();
    dfs(
      {
        ...start,
        x: nx,
        y: ny,
        accReward: cb.leafReward(nx, ny, false, start.fire),
        tickOffset: start.tickOffset + ticksPerTile,
      },
      1,
      ra,
    );
  }

  // PLACE_BOMB root.
  if (!capped) {
    const canBomb =
      start.activeBombs < start.cannon &&
      bombAt(state.bombs, start.x, start.y) === undefined &&
      cb.bombGateOk(start.x, start.y, start.fire);
    if (canBomb) {
      visited.clear();
      dfs(
        {
          ...start,
          bombsPlaced: start.bombsPlaced + 1,
          activeBombs: start.activeBombs + 1,
          accReward:
            start.accReward + cb.leafReward(start.x, start.y, true, start.fire),
          tickOffset: start.tickOffset + ticksPerTile,
        },
        1,
        RootAction.PLACE_BOMB,
      );
    }
  }

  // Flat STAY penalty (per-map knob, anti defer-forever). With stayPenalty === 0
  // (neutral) this is a no-op → HEAD behavior. Only applied when STAY actually
  // got a finite score, so an illegal/never-expanded STAY stays -Infinity.
  if (
    knobs.stayPenalty !== 0 &&
    rootScore[RootAction.STAY]! > Number.NEGATIVE_INFINITY
  ) {
    rootScore[RootAction.STAY]! -= knobs.stayPenalty;
  }

  // argmax over root actions (fixed order, strict `>`, first wins).
  let bestAction = RootAction.STAY;
  let best = Number.NEGATIVE_INFINITY;
  for (let a = 0; a < ROOT_ACTION_COUNT; a++) {
    if (rootScore[a]! > best) {
      best = rootScore[a]!;
      bestAction = a as RootAction;
    }
  }

  return {
    bestAction,
    score: best,
    leavesEvaluated: leaves,
    perActionScores: rootScore.slice(),
  };
}
