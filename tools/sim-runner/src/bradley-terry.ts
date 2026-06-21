/**
 * Bradley-Terry rating estimation for the AI version ladder.
 *
 * The model: each agent i has a latent strength β_i, and the probability that i
 * beats j is the logistic σ(β_i − β_j) = p_i / (p_i + p_j), where p_i = exp(β_i).
 * Given a (possibly SPARSE) set of pairwise win/loss/draw counts, we recover the
 * β that maximise the likelihood of the observed results. Two agents that never
 * met are still placed on one scale as long as the comparison graph is
 * connected — that is the whole point: a new version only has to play "enough"
 * against the pool, and the joint fit ranks everyone together.
 *
 * Everything here is a PURE function of the win/games tallies: same input ⇒ same
 * output, no sim, no RNG, no Date / performance. The solver is the classic MM
 * (minorisation–maximisation) iteration (Hunter 2004), which is gradient-free
 * and monotonically converges. Draws count as half a win to each side, matching
 * the rest of the bench (and the BT likelihood we report).
 *
 * Scale: β is shift-invariant (only differences matter), so the result is
 * anchored — the mean β over a chosen reference set is pinned to 0 (Elo 1500).
 * Pinning the v3 reference pool keeps "1500 = average v3" stable across refits,
 * so v4 / v5 ratings stay directly comparable as new data is folded in.
 */

import type { GameOutcome } from './matrix-stats';

/** Elo points per unit of natural-log strength (the standard 400 / ln 10). */
const ELO_PER_BETA = 400 / Math.LN10;

/** Default Elo assigned to the anchored mean of the reference set. */
export const DEFAULT_ANCHOR_ELO = 1500;

/**
 * Head-to-head tallies as two n×n matrices. `wins[i][j]` is i's win credit vs j
 * (a draw adds 0.5 to each side); `games[i][j]` is the total games i played vs j
 * and is symmetric (`games[i][j] === games[j][i]`). Diagonals are unused (0).
 */
export interface WinGamesTally {
  wins: number[][];
  games: number[][];
}

/** Knobs for the fit. All optional; the defaults suit the AI ladder. */
export interface BTOptions {
  /**
   * Regularisation strength: `prior` virtual games, scored as a draw, against a
   * phantom opponent of average strength (p = 1). Pulls each rating gently
   * toward the mean so an agent that won (or lost) ALL its games gets a finite
   * rating instead of diverging to ±∞. 0 = exact (unregularised) MLE.
   */
  prior?: number;
  /** Convergence threshold on the max |Δ log-strength| between iterations. */
  tol?: number;
  /** Hard cap on MM iterations (a safety net; convergence is typically fast). */
  maxIter?: number;
  /**
   * Indices whose mean β is pinned to 0 (→ Elo `anchorElo`). Defaults to ALL
   * agents. Pass the reference-pool indices (e.g. the v3 archetypes) to keep the
   * scale's origin fixed as challengers are added.
   */
  anchorIndices?: number[];
  /** Elo value the anchored mean maps to. Default 1500. */
  anchorElo?: number;
}

/** The fitted ratings plus convergence / fit diagnostics. */
export interface BTResult {
  /** Log-strength per agent, anchored so the reference set's mean β = 0. */
  beta: number[];
  /** Elo per agent: anchorElo + ELO_PER_BETA · β. */
  elo: number[];
  /** Strength per agent: exp(β) (pre-anchor scale; ratios are what matter). */
  strength: number[];
  /** MM iterations actually run. */
  iterations: number;
  /** True if the iteration met `tol` before `maxIter`. */
  converged: boolean;
  /** Bradley-Terry log-likelihood of the tallies under the fitted ratings. */
  logLikelihood: number;
}

const DEFAULTS = {
  prior: 1.0,
  tol: 1e-10,
  maxIter: 10_000,
  anchorElo: DEFAULT_ANCHOR_ELO,
} as const;

/**
 * Fold per-game outcomes into win/games matrices. A win is 1/0, a draw is
 * 0.5/0.5; `games` is incremented symmetrically. This is the bridge from a
 * fresh batch of matches (GameOutcome[]) to the tallies the fit and the history
 * store both speak. Fixed iteration order ⇒ bit-deterministic.
 */
export function tallyWinsGames(outcomes: GameOutcome[], n: number): WinGamesTally {
  const wins = zeros(n);
  const games = zeros(n);
  for (const o of outcomes) {
    const { agentA, agentB } = o;
    games[agentA]![agentB]! += 1;
    games[agentB]![agentA]! += 1;
    if (o.winnerAgent === null) {
      wins[agentA]![agentB]! += 0.5;
      wins[agentB]![agentA]! += 0.5;
    } else if (o.winnerAgent === agentA) {
      wins[agentA]![agentB]! += 1;
    } else {
      wins[agentB]![agentA]! += 1;
    }
  }
  return { wins, games };
}

/**
 * Fit Bradley-Terry ratings from win/games tallies via the MM iteration.
 *
 * Strength space (p_i = exp β_i) update, with a draw-vs-phantom prior:
 *   p_i ← (W_i + prior/2) / ( Σ_{j≠i} n_ij/(p_i+p_j) + prior/(p_i+1) )
 * where W_i = Σ_j wins[i][j] and n_ij = games[i][j]. We renormalise to geometric
 * mean 1 each step (β is only defined up to a shift), iterate to `tol`, then
 * re-anchor β so the reference set's mean is 0 and convert to Elo.
 */
export function fitBradleyTerry(tally: WinGamesTally, opts: BTOptions = {}): BTResult {
  const prior = opts.prior ?? DEFAULTS.prior;
  const tol = opts.tol ?? DEFAULTS.tol;
  const maxIter = opts.maxIter ?? DEFAULTS.maxIter;
  const anchorElo = opts.anchorElo ?? DEFAULTS.anchorElo;
  const { wins, games } = tally;
  const n = wins.length;

  // Total win credit per agent (numerator base, prior-augmented once up front).
  const W = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += wins[i]![j]!;
    W[i] = s;
  }

  // Strengths start equal; the MM map is monotone so the start point only
  // affects iteration count, never the (unique, with prior) fixed point.
  let p = new Array<number>(n).fill(1);
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIter; iterations++) {
    const next = new Array<number>(n).fill(1);
    for (let i = 0; i < n; i++) {
      let denom = prior / (p[i]! + 1); // virtual draw vs phantom (strength 1)
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const nij = games[i]![j]!;
        if (nij !== 0) denom += nij / (p[i]! + p[j]!);
      }
      next[i] = denom === 0 ? p[i]! : (W[i]! + prior / 2) / denom;
    }
    // Renormalise to geometric mean 1 (pin the free scale), then test |Δ log p|.
    normaliseGeoMean(next);
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(Math.log(next[i]!) - Math.log(p[i]!));
      if (d > maxDelta) maxDelta = d;
    }
    p = next;
    if (maxDelta < tol) {
      iterations++;
      converged = true;
      break;
    }
  }

  // β = log p, then re-anchor so the reference set's mean β is 0.
  const beta = p.map((v) => Math.log(v));
  const anchorIdx =
    opts.anchorIndices && opts.anchorIndices.length > 0
      ? opts.anchorIndices
      : Array.from({ length: n }, (_, i) => i);
  let anchorMean = 0;
  for (const i of anchorIdx) anchorMean += beta[i]!;
  anchorMean /= anchorIdx.length;
  for (let i = 0; i < n; i++) beta[i]! -= anchorMean;

  const strength = beta.map((b) => Math.exp(b));
  const elo = beta.map((b) => anchorElo + ELO_PER_BETA * b);
  return {
    beta,
    elo,
    strength,
    iterations,
    converged,
    logLikelihood: logLikelihood(tally, beta),
  };
}

/**
 * Bradley-Terry log-likelihood of the tallies under log-strengths β. Summed over
 * ordered pairs as wins[i][j] · log σ(β_i − β_j); shift-invariant, so it can be
 * computed from anchored β directly. Useful as a fit-quality / goodness number.
 */
export function logLikelihood(tally: WinGamesTally, beta: number[]): number {
  const { wins } = tally;
  const n = wins.length;
  let ll = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const w = wins[i]![j]!;
      if (w === 0) continue;
      ll += w * Math.log(predictedWinProb(beta[i]!, beta[j]!));
    }
  }
  return ll;
}

/** P(A beats B) under Bradley-Terry given log-strengths: σ(βA − βB). */
export function predictedWinProb(betaA: number, betaB: number): number {
  return 1 / (1 + Math.exp(betaB - betaA));
}

/** Convert a β difference to Elo points (and a single β to its Elo offset). */
export function eloFromBeta(beta: number, anchorElo = DEFAULT_ANCHOR_ELO): number {
  return anchorElo + ELO_PER_BETA * beta;
}

/**
 * Connected components of the comparison graph (edge ⇔ the pair played ≥1 game),
 * as a list of agent-index groups. The Bradley-Terry fit only places agents on a
 * shared scale WITHIN a connected component; if this returns more than one
 * group, ratings across groups are not comparable and the caller should refuse
 * to rank (or demand more cross-group matches). Deterministic union-find.
 */
export function connectedComponents(games: number[][]): number[][] {
  const n = games.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r]! !== r) r = parent[r]!;
    while (parent[x]! !== r) {
      const nx = parent[x]!;
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (games[i]![j]! > 0) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }
  return Array.from(groups.values()).sort((a, b) => a[0]! - b[0]!);
}

/** True iff every agent is in one connected component (a single shared scale). */
export function isConnected(games: number[][]): boolean {
  return games.length <= 1 || connectedComponents(games).length === 1;
}

// --- internals --------------------------------------------------------------

function zeros(n: number): number[][] {
  return Array.from({ length: n }, () => new Array<number>(n).fill(0));
}

/** Scale `p` in place so its geometric mean is 1 (pins the free β shift). */
function normaliseGeoMean(p: number[]): void {
  let sumLog = 0;
  for (const v of p) sumLog += Math.log(v);
  const factor = Math.exp(-sumLog / p.length);
  for (let i = 0; i < p.length; i++) p[i]! *= factor;
}
