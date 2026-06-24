/**
 * meta-rank — cycle-aware evaluation of the AI ladder (α-Rank + Nash-averaging),
 * a companion to `bt-rank` for a DELIBERATELY NON-TRANSITIVE (rock-paper-scissors)
 * roster.
 *
 * Why this exists (vs bt-rank): Bradley-Terry assigns every agent a single scalar
 * strength β and models P(i beats j) = σ(β_i − β_j). That model literally cannot
 * represent a cycle (a>b>c>a), so on the v3 RPS roster it COMPRESSES the cycle
 * and can misorder the top — exactly the limitation docs/ai-versions.md §七 already
 * notes and patches with per-opponent residuals. This tool computes the two
 * standard cycle-aware alternatives directly from the SAME committed bt-history:
 *
 *   - α-Rank (Omidshafiei et al., "α-Rank: Multi-Agent Evaluation by Evolution",
 *     Nature 2019): rank by the stationary distribution of an evolutionary Markov
 *     chain over the response graph. Handles intransitive/cyclic payoffs natively;
 *     mass concentrates on the strategies a population keeps returning to.
 *
 *   - Nash-averaging (Balduzzi et al., "Re-evaluating Evaluation", NeurIPS 2018):
 *     rate each agent by its expected logit-payoff against the maximum-entropy
 *     Nash mixture of the symmetric zero-sum meta-game. Its headline property is
 *     INVARIANCE TO REDUNDANT/CLONE AGENTS — a near-duplicate of the champion
 *     shares Nash mass with it and does NOT distort everyone else's rating, which
 *     mean-win-rate and Elo both fail at. That directly answers "does adding the
 *     near-clones v4:zoner / v5:zoner to the v6 pool skew the ranking?".
 *
 * Read-only: loads bt-history/{map}.json, fits nothing it persists, writes no
 * files. This is an analysis script in tools/ (NOT sim/** or ai/**), so floats /
 * Math.* are fine — the lockstep determinism ban does not apply here.
 *
 *   npm run meta-rank -- [--map=classic|pirate] [--alpha=10] [--pop=50]
 *                        [--include-noise]
 *
 * α and pop are the α-Rank selection intensity and (finite) population size; the
 * resulting ORDER is robust across a wide α range (we print the chain's ranking,
 * not just one α's masses).
 */

import { MAPS, type MapKind } from './bench-utils';
import {
  type History,
  agentIds,
  toTally,
} from './bt-history';
import { fitBradleyTerry, predictedWinProb } from './bradley-terry';
import { V3_NOISE, V3_POOL, arg, loadHistory } from './bt-common';

/** A complete pairwise win-probability matrix plus which cells were imputed. */
interface WinMatrix {
  /** M[i][j] = P(i beats j) in [0,1]; M[i][i] = 0.5 (self-play). */
  m: number[][];
  /** imputed[i][j] = true if the pair never met and the cell came from BT. */
  imputed: boolean[][];
  /** β from the BT fit (used for imputing missing cells and the BT column). */
  beta: number[];
}

function main(): void {
  const argv = process.argv.slice(2);
  const includeNoise = argv.includes('--include-noise');
  const alpha = Number(arg(argv, 'alpha', '10'));
  const pop = Number(arg(argv, 'pop', '50'));
  const mapArg = arg(argv, 'map', '');
  const selMaps = mapArg
    ? (mapArg.split(',').map((s) => s.trim()) as MapKind[]).filter((m) => MAPS.includes(m))
    : MAPS;

  console.log(
    `meta-rank — cycle-aware evaluation (α-Rank + Nash-averaging)\n` +
      `  maps=[${selMaps.join(', ')}]  alpha=${alpha}  pop=${pop}` +
      (includeNoise ? '  (+noise)' : ''),
  );

  for (const map of selMaps) {
    const history = loadHistory(map);
    reportMap(map, history, { includeNoise, alpha, pop });
  }
}

function reportMap(
  map: MapKind,
  history: History,
  opts: { includeNoise: boolean; alpha: number; pop: number },
): void {
  // Agent set: everything in the history, optionally dropping the noise judge.
  let ids = agentIds(history);
  if (!opts.includeNoise) ids = ids.filter((id) => stripVer(id) !== V3_NOISE);
  const n = ids.length;
  if (n < 2) {
    console.log(`\n${map}: not enough agents in history.`);
    return;
  }

  const { m, imputed } = buildWinMatrix(history, ids);

  // --- BT (anchored to v3 pool mean = 1500), for the side-by-side column. ----
  const anchorIndices = ids
    .map((id, i) => (V3_POOL.includes(stripVer(id)) && id.startsWith('v3:') ? i : -1))
    .filter((i) => i >= 0);
  const bt = fitBradleyTerry(toTally(history, ids), { anchorIndices });
  const btElo = ids.map((_, i) => bt.elo[i]!);

  // --- α-Rank: stationary distribution of the evolutionary Markov chain. -----
  const alphaMass = alphaRank(m, opts.alpha, opts.pop);

  // --- Nash-averaging over the antisymmetric logit meta-game. ----------------
  const { nash, rating } = nashAverage(m);

  // Rankings (each as a sorted list of agent indices, best first).
  const byBt = order(ids, (i) => btElo[i]!);
  const byAlpha = order(ids, (i) => alphaMass[i]!);
  const byNash = order(ids, (i) => rating[i]!); // higher (closer to 0) = better

  const imputedPairs = countImputed(imputed);

  console.log(`\n══ ${map} ══  (${n} agents${imputedPairs ? `, ${imputedPairs} imputed pair(s) via BT` : ''})`);

  // Side-by-side table: BT Elo | α-Rank mass% (rank) | Nash rating + mass%.
  console.log('  agent           BT-Elo    α-Rank        Nash-avg');
  console.log('  ─────────────   ──────    ──────────    ──────────────');
  // Print in α-Rank order (the cycle-aware "headline" ranking).
  for (let r = 0; r < n; r++) {
    const i = byAlpha[r]!;
    const id = ids[i]!;
    const aPct = (alphaMass[i]! * 100).toFixed(1).padStart(5);
    const nPct = (nash[i]! * 100).toFixed(1).padStart(5);
    const nr = rating[i]!;
    console.log(
      `  ${id.padEnd(13)}   ${btElo[i]!.toFixed(0).padStart(4)}     ${aPct}%       ` +
        `${(nr >= 0 ? '+' : '') + nr.toFixed(2)}  (mass ${nPct}%)`,
    );
  }

  // Where the cycle-aware order disagrees with BT (the whole point).
  const btTop = byBt.map((i) => ids[i]!);
  const alphaTop = byAlpha.map((i) => ids[i]!);
  const nashTop = byNash.map((i) => ids[i]!);
  console.log(`  BT order      : ${btTop.join(' > ')}`);
  console.log(`  α-Rank order  : ${alphaTop.join(' > ')}${sameOrder(btTop, alphaTop) ? '   (= BT)' : '   ⟵ differs from BT'}`);
  console.log(`  Nash order    : ${nashTop.join(' > ')}${sameOrder(btTop, nashTop) ? '   (= BT)' : '   ⟵ differs from BT'}`);

  // Nash support = the "essential" / non-redundant agents (mass > ~1%).
  const support = ids.map((id, i) => ({ id, mass: nash[i]! })).filter((x) => x.mass > 0.01);
  console.log(
    `  Nash support (non-redundant): ${support
      .sort((a, b) => b.mass - a.mass)
      .map((x) => `${x.id} ${(x.mass * 100).toFixed(0)}%`)
      .join(', ')}`,
  );

  // Interpretation: if α-Rank concentrates almost all mass on one agent, that
  // agent is a response-graph SINK (beats the whole pool) → there is NO top-level
  // cycle, so BT is trustworthy AT THE CHAMPION. The cyclic structure (where the
  // methods disagree) lives in the mid-pool; say so explicitly.
  const topAlpha = byAlpha[0]!;
  if (alphaMass[topAlpha]! > 0.95) {
    console.log(
      `  read: ${ids[topAlpha]} is a dominant strategy over this pool (α-Rank sink, ` +
        `Nash support) — no top-level cycle, so BT's #1 is reliable. The RPS ring is ` +
        `mid-pool, where BT/α-Rank/Nash orders above DISAGREE.`,
    );
  }

  // Clone-sensitivity readout — the empirical answer to "include v4 AND v5 in the
  // v6 pool?" (the near-duplicate champions).
  reportCloneStory(ids, m, imputed, nash, btElo);
}

/** Build a complete win-prob matrix, imputing never-played pairs from BT. */
function buildWinMatrix(history: History, ids: string[]): WinMatrix {
  const n = ids.length;
  const { wins, games } = toTally(history, ids);
  const anchorIndices = ids
    .map((id, i) => (V3_POOL.includes(stripVer(id)) && id.startsWith('v3:') ? i : -1))
    .filter((i) => i >= 0);
  const bt = fitBradleyTerry({ wins, games }, { anchorIndices });
  const beta = bt.beta;

  const m = Array.from({ length: n }, () => new Array<number>(n).fill(0.5));
  const imputed = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        m[i]![j] = 0.5;
        continue;
      }
      const g = games[i]![j]!;
      if (g > 0) {
        m[i]![j] = clamp01(wins[i]![j]! / g);
      } else {
        m[i]![j] = clamp01(predictedWinProb(beta[i]!, beta[j]!));
        imputed[i]![j] = true;
      }
    }
  }
  return { m, imputed, beta };
}

/**
 * α-Rank stationary distribution (single-population, 2-player symmetric game).
 *
 * Build the response-graph Markov chain C over monomorphic states: from a
 * resident σ, a mutant s (chosen uniformly, η = 1/(n−1)) fixates with the Moran
 * probability ρ at selection intensity α and population size m. For a 2-player
 * game the payoff gap is the constant d = M[s][σ] − M[σ][s] = 2·M[s][σ] − 1, so
 * ρ has the standard closed form. The α-Rank score is the chain's stationary
 * distribution (mass = how much an infinite population dwells on each strategy).
 */
function alphaRank(m: number[][], alpha: number, pop: number): number[] {
  const n = m.length;
  const eta = 1 / (n - 1);
  const C = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let sigma = 0; sigma < n; sigma++) {
    let off = 0;
    for (let s = 0; s < n; s++) {
      if (s === sigma) continue;
      const d = 2 * m[s]![sigma]! - 1; // payoff(mutant s) − payoff(resident σ)
      const rho = fixation(d, alpha, pop);
      C[sigma]![s] = eta * rho;
      off += eta * rho;
    }
    C[sigma]![sigma] = 1 - off; // self-loop holds the leftover mass
  }
  return stationary(C);
}

/** Moran fixation probability of a single mutant with payoff gap d. */
function fixation(d: number, alpha: number, m: number): number {
  if (Math.abs(d) < 1e-12) return 1 / m; // neutral drift
  const x = alpha * d;
  // ρ = (1 − e^{−x}) / (1 − e^{−m x}); guard the large-|x| limits numerically.
  const num = 1 - Math.exp(-x);
  const den = 1 - Math.exp(-m * x);
  if (!isFinite(den) || Math.abs(den) < 1e-300) {
    return x > 0 ? 1 : 0; // strong selection: advantageous → ~1, deleterious → ~0
  }
  return clamp01(num / den);
}

/** Stationary distribution of a row-stochastic matrix via power iteration. */
function stationary(C: number[][]): number[] {
  const n = C.length;
  let p = new Array<number>(n).fill(1 / n);
  for (let iter = 0; iter < 20000; iter++) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const pi = p[i]!;
      if (pi === 0) continue;
      for (let j = 0; j < n; j++) next[j]! += pi * C[i]![j]!;
    }
    let delta = 0;
    for (let i = 0; i < n; i++) delta = Math.max(delta, Math.abs(next[i]! - p[i]!));
    p = next;
    if (delta < 1e-14) break;
  }
  return normalise(p);
}

/**
 * Nash-averaging over the antisymmetric logit meta-game A[i][j] = logit(M[i][j]).
 * Find a symmetric maxent-ish Nash p* of the symmetric zero-sum game with payoff
 * A via Hedge (multiplicative-weights) self-play from a uniform start (the
 * time-average converges to a Nash; the symmetric uniform start makes EXACT
 * clones receive EQUAL mass — the clone-invariance we want to showcase). Then
 * rate each agent by (A p*)_i: its expected logit-payoff vs the Nash mixture.
 * Support agents sit at ≈0 (they tie the meta-Nash); exploitable agents < 0.
 */
function nashAverage(m: number[][]): { nash: number[]; rating: number[] } {
  const n = m.length;
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      A[i]![j] = logit(m[i]![j]!);
    }
  }
  // Hedge self-play. Fixed small step; average the iterate (standard for the
  // last-iterate-cycles issue in zero-sum). 50k iters is ample for ≤10 agents.
  const eta = 0.05;
  const w = new Array<number>(n).fill(1);
  const avg = new Array<number>(n).fill(0);
  let p = normalise(w.slice());
  const ITERS = 50000;
  for (let t = 0; t < ITERS; t++) {
    p = normalise(w);
    for (let i = 0; i < n; i++) avg[i]! += p[i]!;
    // gradient g_i = (A p)_i ; ascend it.
    for (let i = 0; i < n; i++) {
      let g = 0;
      for (let j = 0; j < n; j++) g += A[i]![j]! * p[j]!;
      w[i]! *= Math.exp(eta * g);
    }
    // Renormalise weights to avoid overflow (scale-free).
    const mx = Math.max(...w);
    if (mx > 1e120) for (let i = 0; i < n; i++) w[i]! /= mx;
  }
  const nash = normalise(avg);
  const rating = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let j = 0; j < n; j++) r += A[i]![j]! * nash[j]!;
    rating[i] = r;
  }
  return { nash, rating };
}

/**
 * Clone-sensitivity readout. The live champions v4:zoner and v5:zoner are
 * near-duplicate policies; mean-win-rate and Elo both let a near-clone in the
 * pool tilt the field, while Nash-averaging splits their shared mass and leaves
 * the rest of the rating untouched. Print their direct/near win-rate and how
 * Nash apportions their combined mass — the empirical answer to the v6 question.
 */
function reportCloneStory(
  ids: string[],
  m: number[][],
  imputed: boolean[][],
  nash: number[],
  btElo: number[],
): void {
  const clones = ids
    .map((id, i) => ({ id, i }))
    .filter((x) => x.id.endsWith(':zoner') && /^v[45]:/.test(x.id));
  if (clones.length < 2) return;
  console.log('  clone check — v4:zoner / v5:zoner (near-duplicate champions; the v6 pool question):');
  for (const c of clones) {
    console.log(
      `    ${c.id.padEnd(10)} BT-Elo ${btElo[c.i]!.toFixed(0)}  Nash-mass ${(nash[c.i]! * 100).toFixed(1)}%`,
    );
  }
  const a = clones[0]!; // v4:zoner (ids are sorted, v4 < v5)
  const b = clones[1]!; // v5:zoner
  const wr = m[a.i]![b.i]!;
  const isImputed = imputed[a.i]![b.i]! || imputed[b.i]![a.i]!;
  const note = isImputed
    ? '  (BT-IMPUTED — this pair was never played directly; see `v5-probe` for the real CRN number)'
    : '';
  console.log(`    ${a.id} beats ${b.id}: ${(wr * 100).toFixed(0)}%${note}`);
  // Adaptive lesson: equal clones split mass; a dominated clone is discarded.
  const massA = nash[a.i]!;
  const massB = nash[b.i]!;
  const dominated = Math.min(massA, massB) < 0.05 && Math.max(massA, massB) > 0.5;
  if (dominated) {
    const winner = massA > massB ? a.id : b.id;
    const loser = massA > massB ? b.id : a.id;
    console.log(
      `    → Nash gives ${loser} ~0% (redundant: dominated by ${winner}); ` +
        `it does NOT distort the rest of the field. So including BOTH v4 and v5 in the v6 ` +
        `pool is harmless under Nash-averaging — unlike mean-win-rate/Elo, where a near-clone ` +
        `tilts the average. Gate v6 against the Nash-support champion (${winner}).`,
    );
  } else {
    console.log(
      `    → Nash splits their combined mass (${((massA + massB) * 100).toFixed(0)}%) across the ` +
        `two near-clones rather than letting the duplicate inflate the field (clone-invariance); ` +
        `mean-win-rate/Elo would double-count the slot.`,
    );
  }
}

// --- small helpers ----------------------------------------------------------

function order(ids: string[], key: (i: number) => number): number[] {
  return ids.map((_, i) => i).sort((x, y) => key(y) - key(x) || ids[x]!.localeCompare(ids[y]!));
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function countImputed(imputed: boolean[][]): number {
  let c = 0;
  for (let i = 0; i < imputed.length; i++)
    for (let j = i + 1; j < imputed.length; j++) if (imputed[i]![j]) c++;
  return c;
}

function normalise(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x;
  if (s <= 0) return v.map(() => 1 / v.length);
  return v.map((x) => x / s);
}

function clamp01(x: number): number {
  return x < 1e-6 ? 1e-6 : x > 1 - 1e-6 ? 1 - 1e-6 : x;
}

function logit(p: number): number {
  const q = clamp01(p);
  return Math.log(q / (1 - q));
}

function stripVer(id: string): string {
  const i = id.indexOf(':');
  return i < 0 ? id : id.slice(i + 1);
}

main();
