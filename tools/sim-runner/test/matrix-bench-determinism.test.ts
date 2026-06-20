/**
 * CRN red-line guard for the 1v1 round-robin matrix bench.
 *
 * Four concerns, mirroring the spec:
 *  1. Single-thread bit-identity: two serial runs of a small schedule produce
 *     byte-identical per-game records (no nondeterminism in the sim/AI path).
 *  2. Parallel == serial: the worker_threads path (workers > 1) returns results
 *     deep-equal to the serial reference path — the CRN red line. This actually
 *     spawns workers (small schedule so it stays fast).
 *  3. CRN seed reuse: `scenarioSeed` is a pure function of (map, repeat) only, so
 *     every pairing — and forward vs reverse seating — of a given (map, repeat)
 *     shares ONE seed.
 *  4. Matrix math: hand-built fixtures pin buildWinMatrix / overallScores /
 *     rankAgents / findThreeCycles / decideVerdict (transitive ladder ranks,
 *     symmetric duels → 0.5, A→B→C→A detected, the 59%/60% champion gate).
 */
import { describe, expect, it } from 'vitest';

import { type Agent, makeAgent } from '../src/bench-utils';
import {
  type GameResult,
  buildGameList,
  runAllGames,
  scenarioSeed,
} from '../src/matrix-runner';
import {
  type GameOutcome,
  CHAMPION_GATE,
  buildWinMatrix,
  decideVerdict,
  findThreeCycles,
  overallScores,
  rankAgents,
} from '../src/matrix-stats';

/**
 * A deliberately small schedule (2 versions × 2 archetypes = 4 agents,
 * repeats=1). C(4,2)=6 pairings × (1 fwd + 1 rev) × 2 maps = 24 games — enough
 * to exercise both maps and both seatings (and split across worker shards) while
 * staying fast: under vitest's parallel pool the heavy worker_threads path must
 * finish well within the reporter's RPC heartbeat, so the schedule is kept lean.
 */
function smallAgents(): Agent[] {
  return [
    makeAgent(1, 'aggressor'),
    makeAgent(1, 'gambler'),
    makeAgent(2, 'aggressor'),
    makeAgent(2, 'gambler'),
  ];
}
const SMALL_REPEATS = 1;
/**
 * Short per-match tick cap for the bit-identity / parallel-equality checks.
 * Determinism holds at ANY match length, so cap matches well below the real
 * 3-min game cap (MATCH_MAX_TICKS) to keep the heavy worker-threads path inside
 * vitest's RPC heartbeat — full-length classic duels (no kills) would otherwise
 * run for minutes and stall the reporter.
 */
const SHORT_CAP = 600;

/** Strip a GameResult down to the bytes that matter for an identity check. */
function digest(results: GameResult[]): unknown {
  return results.map((r) => ({
    gameId: r.gameId,
    elimTick: r.record.elimTick,
    slotAgent: r.record.slotAgent,
    winnerAgent: r.record.winnerAgent,
    draw: r.record.draw,
    tiebreak: r.record.tiebreak,
  }));
}

describe('matrix bench — single-thread bit-identity', () => {
  it('two serial runs of the small schedule are byte-identical', async () => {
    const agents = smallAgents();
    const games = buildGameList(agents, SMALL_REPEATS, SHORT_CAP);
    const a = await runAllGames(games, agents, { workers: 1 });
    const b = await runAllGames(games, agents, { workers: 1 });

    expect(a.length).toBe(games.length);
    // Per-game, per-slot identity (elimTick / winnerAgent / slotAgent all equal).
    for (let g = 0; g < a.length; g++) {
      expect(a[g]!.gameId).toBe(b[g]!.gameId);
      expect(a[g]!.record.elimTick).toEqual(b[g]!.record.elimTick);
      expect(a[g]!.record.slotAgent).toEqual(b[g]!.record.slotAgent);
      expect(a[g]!.record.winnerAgent).toBe(b[g]!.record.winnerAgent);
    }
    expect(digest(a)).toEqual(digest(b));
  });
});

describe('matrix bench — parallel == serial (CRN red line)', () => {
  it('workers>1 deep-equals workers=1 on the small schedule', async () => {
    const agents = smallAgents();
    const games = buildGameList(agents, SMALL_REPEATS, SHORT_CAP);
    const serial = await runAllGames(games, agents, { workers: 1 });
    // Force the real worker_threads path with more than one shard.
    const parallel = await runAllGames(games, agents, { workers: 4 });

    expect(parallel.length).toBe(serial.length);
    expect(digest(parallel)).toEqual(digest(serial));
  });
});

describe('matrix bench — CRN seed reuse', () => {
  it('scenarioSeed depends only on (map, repeat), shared across all pairings', () => {
    const agents = smallAgents();
    const games = buildGameList(agents, SMALL_REPEATS, SHORT_CAP);

    // Group games by (mapKind, seed) and assert: for a given map, each distinct
    // seed corresponds to exactly one repeat, and ALL pairings that ran under it
    // (both forward and reverse seatings) carry the identical seed.
    const byMap = new Map<string, Set<number>>();
    for (const g of games) {
      if (!byMap.has(g.mapKind)) byMap.set(g.mapKind, new Set());
      byMap.get(g.mapKind)!.add(g.seed);
    }
    // 2 repeats per map → exactly 2 distinct seeds per map.
    for (const seeds of byMap.values()) {
      expect(seeds.size).toBe(SMALL_REPEATS);
    }

    // The pure seed function: same (map, repeat) → same seed; forward & reverse
    // share it; different repeats differ; different maps differ.
    expect(scenarioSeed(0, 0)).toBe(scenarioSeed(0, 0));
    expect(scenarioSeed(0, 0)).not.toBe(scenarioSeed(0, 1)); // repeat changes seed
    expect(scenarioSeed(0, 0)).not.toBe(scenarioSeed(1, 0)); // map changes seed

    // Directly inspect the built list: forward (slot0=i) and its very next
    // reverse (slot0=j) game share one seed, for every pairing/repeat/map.
    for (let k = 0; k < games.length; k += 2) {
      const fwd = games[k]!;
      const rev = games[k + 1]!;
      expect(rev.seed).toBe(fwd.seed);
      expect(rev.mapKind).toBe(fwd.mapKind);
      // Reverse swaps the seats but reuses the seed.
      expect(rev.slot0Agent).toBe(fwd.slot1Agent);
      expect(rev.slot1Agent).toBe(fwd.slot0Agent);
    }
  });
});

describe('matrix stats — pure math fixtures', () => {
  it('buildWinMatrix: symmetric split → 0.5, draws count half', () => {
    // Two agents, two games, one win each → 0.5 both ways. The second game seats
    // them swapped (agentA=1) and is won by agent 1, so each agent wins once.
    const outcomes: GameOutcome[] = [
      { agentA: 0, agentB: 1, winnerAgent: 0 },
      { agentA: 1, agentB: 0, winnerAgent: 1 },
    ];
    const m = buildWinMatrix(outcomes, 2);
    expect(m[0]![1]).toBeCloseTo(0.5, 10);
    expect(m[1]![0]).toBeCloseTo(0.5, 10);

    // A draw splits 0.5 / 0.5.
    const drawn = buildWinMatrix([{ agentA: 0, agentB: 1, winnerAgent: null }], 2);
    expect(drawn[0]![1]).toBeCloseTo(0.5, 10);
    expect(drawn[1]![0]).toBeCloseTo(0.5, 10);

    // cell[j][i] === 1 - cell[i][j] for a decisive set.
    const lop = buildWinMatrix(
      [
        { agentA: 0, agentB: 1, winnerAgent: 0 },
        { agentA: 0, agentB: 1, winnerAgent: 0 },
      ],
      2,
    );
    expect(lop[0]![1]).toBeCloseTo(1, 10);
    expect(lop[1]![0]).toBeCloseTo(0, 10);
  });

  it('rankAgents: a transitive ladder sorts strongest-first', () => {
    // 0 beats everyone, 1 beats 2 and 3, 2 beats 3 — a clean ladder.
    const matrix = [
      [0, 1, 1, 1],
      [0, 0, 1, 1],
      [0, 0, 0, 1],
      [0, 0, 0, 0],
    ];
    const scores = overallScores(matrix);
    const ranked = rankAgents(scores);
    expect(ranked).toEqual([0, 1, 2, 3]);
    expect(findThreeCycles(matrix)).toEqual([]); // acyclic ladder
  });

  it('findThreeCycles: detects A→B→C→A and dedupes rotations', () => {
    // 0 beats 1, 1 beats 2, 2 beats 0 → one rock-paper-scissors ring.
    const matrix = [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ];
    const cycles = findThreeCycles(matrix);
    expect(cycles.length).toBe(1);
    // Canonicalized to start at the smallest member (0), preserving direction.
    expect(cycles[0]).toEqual([0, 1, 2]);
  });

  it('decideVerdict: 60% gate crowns, 59% is co-leaders', () => {
    // Two clear leaders (0,1) over weak 2,3; vary only the 0-vs-1 head-to-head.
    const build = (h2h: number): number[][] => [
      [0, h2h, 1, 1],
      [1 - h2h, 0, 1, 1],
      [0, 0, 0, 0.5],
      [0, 0, 0.5, 0],
    ];

    // 60% exactly: gate clears → single champion.
    const at60 = build(0.6);
    const v60 = decideVerdict(at60, rankAgents(overallScores(at60)), findThreeCycles(at60));
    expect(v60.champion).toBe(0);
    expect(v60.runnerUp).toBe(1);
    expect(v60.single).toBe(true);
    expect(v60.headToHead).toBeCloseTo(CHAMPION_GATE, 10);

    // 59%: below the gate → co-leaders, no single champion.
    const at59 = build(0.59);
    const v59 = decideVerdict(at59, rankAgents(overallScores(at59)), findThreeCycles(at59));
    expect(v59.single).toBe(false);
  });

  it('decideVerdict: champion tangled with runner-up in a 3-cycle → co-leaders', () => {
    // 0→1→2→0 ring at the top (all > 0.5), even though one h2h ≥ 60%: a
    // non-transitive top must NOT be crowned a single champion.
    const matrix = [
      [0, 0.7, 0.3, 1],
      [0.3, 0, 0.7, 1],
      [0.7, 0.3, 0, 1],
      [0, 0, 0, 0],
    ];
    const ranked = rankAgents(overallScores(matrix));
    const cycles = findThreeCycles(matrix);
    expect(cycles.length).toBeGreaterThan(0);
    const verdict = decideVerdict(matrix, ranked, cycles);
    // 0,1,2 tie on overall score (each 0.667) → champion=0, runnerUp=1 by index;
    // cell[0][1]=0.7 clears the 60% gate, but the 0→1→2→0 ring ties them, so the
    // non-transitive top must NOT be crowned a single champion.
    expect(verdict.champion).toBe(0);
    expect(verdict.runnerUp).toBe(1);
    expect(verdict.headToHead).toBeGreaterThanOrEqual(CHAMPION_GATE);
    expect(
      cycles.some((c) => c.includes(verdict.champion) && c.includes(verdict.runnerUp)),
    ).toBe(true);
    expect(verdict.single).toBe(false);
    expect(verdict.championInCycle).toBe(true);
  });
});
