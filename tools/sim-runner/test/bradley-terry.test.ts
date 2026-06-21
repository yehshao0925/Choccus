import { describe, it, expect } from 'vitest';
import {
  tallyWinsGames,
  fitBradleyTerry,
  predictedWinProb,
  connectedComponents,
  isConnected,
  type WinGamesTally,
} from '../src/bradley-terry';
import type { GameOutcome } from '../src/matrix-stats';

/** Build a symmetric games matrix and a wins matrix from a list of (i,j,winsI). */
function tally(n: number, edges: Array<[number, number, number, number]>): WinGamesTally {
  const wins = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const games = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  // edge = [i, j, winsI, winsJ]
  for (const [i, j, wi, wj] of edges) {
    wins[i]![j]! += wi;
    wins[j]![i]! += wj;
    games[i]![j]! += wi + wj;
    games[j]![i]! += wi + wj;
  }
  return { wins, games };
}

describe('fitBradleyTerry', () => {
  it('gives equal ratings to a perfectly symmetric round-robin', () => {
    // Three agents, each 50/50 vs the others.
    const t = tally(3, [
      [0, 1, 50, 50],
      [0, 2, 50, 50],
      [1, 2, 50, 50],
    ]);
    const r = fitBradleyTerry(t);
    expect(r.converged).toBe(true);
    expect(r.elo[0]!).toBeCloseTo(1500, 6);
    expect(r.elo[1]!).toBeCloseTo(1500, 6);
    expect(r.elo[2]!).toBeCloseTo(1500, 6);
  });

  it('orders a strict dominance chain A > B > C', () => {
    // A beats B 70/30, B beats C 70/30, A beats C 85/15.
    const t = tally(3, [
      [0, 1, 70, 30],
      [1, 2, 70, 30],
      [0, 2, 85, 15],
    ]);
    const r = fitBradleyTerry(t);
    expect(r.converged).toBe(true);
    expect(r.elo[0]!).toBeGreaterThan(r.elo[1]!);
    expect(r.elo[1]!).toBeGreaterThan(r.elo[2]!);
  });

  it('recovers known strengths from SPARSE data (no direct A-vs-C games)', () => {
    // Ground truth betas: A=+0.8, B=0, C=-0.8. Generate large samples for the
    // A-B and B-C edges only (C and A never meet); the joint fit should still
    // place them in order and roughly recover the gaps via the shared opponent.
    const N = 100000;
    const pAB = predictedWinProb(0.8, 0.0); // A beats B
    const pBC = predictedWinProb(0.0, -0.8); // B beats C
    const t = tally(3, [
      [0, 1, Math.round(N * pAB), Math.round(N * (1 - pAB))],
      [1, 2, Math.round(N * pBC), Math.round(N * (1 - pBC))],
    ]);
    const r = fitBradleyTerry(t, { prior: 0 });
    expect(r.converged).toBe(true);
    // Differences should match the truth gaps (β_A−β_B ≈ 0.8, β_B−β_C ≈ 0.8).
    expect(r.beta[0]! - r.beta[1]!).toBeCloseTo(0.8, 1);
    expect(r.beta[1]! - r.beta[2]!).toBeCloseTo(0.8, 1);
  });

  it('keeps an all-wins agent finite under the prior (no divergence)', () => {
    // Agent 0 sweeps both opponents; without regularisation its rating → +∞.
    const t = tally(3, [
      [0, 1, 50, 0],
      [0, 2, 50, 0],
      [1, 2, 25, 25],
    ]);
    const r = fitBradleyTerry(t, { prior: 1 });
    expect(r.converged).toBe(true);
    expect(Number.isFinite(r.elo[0]!)).toBe(true);
    expect(r.elo[0]!).toBeGreaterThan(r.elo[1]!);
    expect(r.elo[0]!).toBeGreaterThan(r.elo[2]!);
  });

  it('anchors the mean of the reference set to 1500', () => {
    const t = tally(3, [
      [0, 1, 70, 30],
      [1, 2, 70, 30],
      [0, 2, 85, 15],
    ]);
    // Anchor only agents {1,2}; their mean Elo must be exactly 1500.
    const r = fitBradleyTerry(t, { anchorIndices: [1, 2] });
    expect((r.elo[1]! + r.elo[2]!) / 2).toBeCloseTo(1500, 6);
    expect(r.elo[0]!).toBeGreaterThan(1500);
  });

  it('is deterministic: identical input ⇒ identical output', () => {
    const t = tally(4, [
      [0, 1, 60, 40],
      [1, 2, 55, 45],
      [2, 3, 70, 30],
      [0, 3, 80, 20],
    ]);
    const a = fitBradleyTerry(t);
    const b = fitBradleyTerry(t);
    expect(a.elo).toEqual(b.elo);
    expect(a.beta).toEqual(b.beta);
    expect(a.iterations).toBe(b.iterations);
  });

  it('treats draws as half-wins (a pure-draw pair stays equal)', () => {
    const t = tally(2, [[0, 1, 0, 0]]);
    // Inject the draws directly as 0.5 each over 100 games.
    t.wins[0]![1] = 50;
    t.wins[1]![0] = 50;
    t.games[0]![1] = 100;
    t.games[1]![0] = 100;
    const r = fitBradleyTerry(t);
    expect(r.elo[0]!).toBeCloseTo(r.elo[1]!, 6);
  });
});

describe('tallyWinsGames', () => {
  it('folds wins, losses and draws correctly', () => {
    const outcomes: GameOutcome[] = [
      { agentA: 0, agentB: 1, winnerAgent: 0 },
      { agentA: 0, agentB: 1, winnerAgent: 1 },
      { agentA: 0, agentB: 1, winnerAgent: null }, // draw
    ];
    const t = tallyWinsGames(outcomes, 2);
    expect(t.games[0]![1]).toBe(3);
    expect(t.wins[0]![1]).toBe(1.5); // 1 win + 0.5 draw
    expect(t.wins[1]![0]).toBe(1.5);
  });
});

describe('connectivity', () => {
  it('detects a single connected component', () => {
    const games = [
      [0, 5, 0],
      [5, 0, 5],
      [0, 5, 0],
    ];
    expect(isConnected(games)).toBe(true);
    expect(connectedComponents(games)).toEqual([[0, 1, 2]]);
  });

  it('detects a disconnected pool', () => {
    // {0,1} play each other, {2,3} play each other, no cross games.
    const games = [
      [0, 5, 0, 0],
      [5, 0, 0, 0],
      [0, 0, 0, 5],
      [0, 0, 5, 0],
    ];
    expect(isConnected(games)).toBe(false);
    expect(connectedComponents(games)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });
});
