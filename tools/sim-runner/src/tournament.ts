/**
 * Headless FFA bot tournament.
 *
 *   npm run tournament
 *
 * There are FOUR archetypes (see Strategies.ts) and exactly FOUR spawn corners,
 * so every archetype plays in every match. We enumerate the single
 * C(4,4)=1 combination of which four archetypes play, and within that combo run
 * all 4!=24 lexicographic slot permutations (removing positional/corner bias),
 * repeated R times. Total = 1 combo × 24 perms × R=2 = 48 matches per map. Every
 * archetype appears in the sole combo, so match counts stay balanced.
 *
 * Each archetype plays in its OWN team (no teammate rescue). Results are
 * aggregated per REAL strategy index (0..3) across all combos and printed as an
 * ASCII summary sorted by win rate.
 *
 * Draw tiebreak: a match that hits the tick cap with >1 bot still alive is
 * resolved by item-progress — the surviving bot that collected the most pickups
 * (fire + cannon + speed) wins. Only an exact tie on that score (and the
 * fire/cannon secondaries) stays a genuine draw. See `tiebreakWinner`.
 *
 * Pure orchestration: no Date / Math.random / performance — every seed is
 * derived from a running GLOBAL match counter, so repeated runs are
 * bit-identical.
 */
import { GamePhase } from '../../../shared/types';
import {
  PLAYER_START_CANNON,
  PLAYER_START_FIRE,
  PLAYER_START_SPEED_BONUS,
} from '../../../shared/constants';
// Single-version measurement tool: pinned to the latest live AI version (v2).
import { BotController } from '../../../client/src/ai/v2/BotController';
import { botSeed } from '../../../client/src/ai/v2/BotConfig';
import { STRATEGIES } from '../../../client/src/ai/v2/Strategies';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { type InputFrame } from '../../../client/src/sim/InputBuffer';
import { type PlayerState } from '../../../client/src/sim/Player';
import {
  tick,
  createInitialState,
  type SimState,
} from '../../../client/src/sim/Sim';

/** FFA player count = the fixed number of spawn corners. */
const N = 4;
/** Times each (combo, permutation) pairing is replayed. 1×24×2 = 48 matches per map. */
const REPEATS = 2;
/** Per-match tick cap; a match hitting this without a winner is a draw. */
const MAX_TICKS = 10800; // 3 min @ 60 Hz (= shared MATCH_MAX_TICKS)
/** Base match seed; per-match seed = (BASE + globalMatchIndex) >>> 0. */
const BASE = 0x12345678;
/** Map layouts the tournament evaluates, each printed as its own table. */
type MapKind = 'classic' | 'pirate';
const MAPS: readonly MapKind[] = ['classic', 'pirate'];

/**
 * All permutations of [0..n-1] in lexicographic order (deterministic, no RNG).
 * Used to rotate which archetype sits in which slot/corner across matches.
 */
function lexPermutations(n: number): number[][] {
  const base = Array.from({ length: n }, (_, i) => i);
  const out: number[][] = [];
  const recurse = (prefix: number[], rest: number[]): void => {
    if (rest.length === 0) {
      out.push(prefix);
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      recurse([...prefix, rest[i]!], [...rest.slice(0, i), ...rest.slice(i + 1)]);
    }
  };
  recurse([], base);
  return out;
}

/**
 * All `choose`-sized combinations of `arr` in lexicographic order
 * (deterministic, no RNG). Used to enumerate which 4 of the 5 archetypes play
 * each match group. C(4,4) = 1 combination.
 */
function combinations(arr: number[], choose: number): number[][] {
  const out: number[][] = [];
  const recurse = (start: number, prefix: number[]): void => {
    if (prefix.length === choose) {
      out.push(prefix.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      prefix.push(arr[i]!);
      recurse(i + 1, prefix);
      prefix.pop();
    }
  };
  recurse(0, []);
  return out;
}

interface MatchResult {
  /** Elimination tick per slot (end tick if the slot survived). */
  elimTick: number[];
  /** Strategy index occupying each slot this match. */
  slotStrategy: number[];
  /** Strategy index of the sole winner, or null for a draw. */
  winnerStrategy: number | null;
  draw: boolean;
  /** True when the winner was decided by the tick-cap item tiebreak. */
  tiebreak: boolean;
}

/**
 * Item-progress score = number of pickups collected (fire + cannon + speed).
 * Each fire/cannon item is +1 to its stat; each speed item is +4 tenths, so
 * dividing the speed bonus by 4 recovers the speed-item count. Pure integer.
 */
function itemScore(p: PlayerState): number {
  return (
    (p.fire - PLAYER_START_FIRE) +
    (p.cannon - PLAYER_START_CANNON) +
    Math.trunc((p.speedBonusTenths - PLAYER_START_SPEED_BONUS) / 4)
  );
}

/**
 * Pick the tiebreak winner among the given alive slots by item score, then
 * fire, then cannon (all desc). Returns the slot, or null if the top two are
 * exactly tied on every key (a genuine draw). Deterministic: no RNG, and the
 * comparison keys plus stable slot order fully determine the result.
 */
function tiebreakWinner(state: SimState, aliveSlots: number[]): number | null {
  const key = (s: number): [number, number, number] => {
    const p = state.players[s]!;
    return [itemScore(p), p.fire, p.cannon];
  };
  const sorted = aliveSlots
    .slice()
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i]! !== kb[i]!) return kb[i]! - ka[i]!;
      }
      return a - b; // stable, but only reached on a full tie
    });
  const top = sorted[0]!;
  const second = sorted[1]!;
  const kt = key(top);
  const ks = key(second);
  const fullTie = kt.every((v, i) => v === ks[i]!);
  return fullTie ? null : top;
}

/**
 * Run one FFA match and return per-slot survival + winner info.
 * `slotStrat[s]` is the REAL strategy index (0..STRATEGIES.length-1) occupying
 * slot/corner s this match. `globalMatchIndex` is the running match counter used
 * to derive the deterministic per-match seed.
 */
function runMatch(
  globalMatchIndex: number,
  slotStrat: number[],
  mapKind: MapKind,
): MatchResult {
  const seed = (BASE + globalMatchIndex) >>> 0;
  const teams = [0, 1, 2, 3].slice(0, N);
  let state: SimState = createInitialState(seed, makeFeelParams(), N, {
    pvp: true,
    teams,
    map: mapKind,
  });

  const controllers: BotController[] = [];
  for (let s = 0; s < N; s++) {
    // slotStrat[s] = REAL strategy index occupying slot s this match.
    controllers.push(
      new BotController(botSeed(seed, s), STRATEGIES[slotStrat[s]!]!.tuning, s),
    );
  }

  const elimTick: number[] = new Array(N).fill(-1);

  while (state.phase === GamePhase.PLAYING && state.tick < MAX_TICKS) {
    const frame: InputFrame[] = [];
    for (let s = 0; s < N; s++) frame.push(controllers[s]!.sample(state, s));
    state = tick(state, frame);
    // Record first tick at which a slot's player is no longer alive
    // (trapped does NOT count — only !alive is elimination).
    for (let s = 0; s < N; s++) {
      if (elimTick[s] === -1 && !state.players[s]!.alive) elimTick[s] = state.tick;
    }
  }

  const endTick = state.tick;
  for (let s = 0; s < N; s++) if (elimTick[s] === -1) elimTick[s] = endTick;

  const aliveSlots: number[] = [];
  for (let s = 0; s < N; s++) if (state.players[s]!.alive) aliveSlots.push(s);

  let winnerStrategy: number | null = null;
  let draw = true;
  let tiebreak = false;
  if (state.phase === GamePhase.OVER && aliveSlots.length === 1) {
    // Clean last-bot-standing finish.
    winnerStrategy = slotStrat[aliveSlots[0]!]!;
    draw = false;
  } else if (aliveSlots.length > 1) {
    // Hit the tick cap with multiple survivors: break the tie on item progress.
    const winSlot = tiebreakWinner(state, aliveSlots);
    if (winSlot !== null) {
      winnerStrategy = slotStrat[winSlot]!;
      draw = false;
      tiebreak = true;
    }
  }

  return {
    elimTick,
    slotStrategy: slotStrat.slice(),
    winnerStrategy,
    draw,
    tiebreak,
  };
}

interface Aggregate {
  matches: number;
  wins: number;
  survivalSum: number;
  rankSum: number;
  draws: number;
}

/** Derive per-slot rank (1 = died first ... N = survived longest). */
function ranks(result: MatchResult): number[] {
  // Sort slots by elimination tick asc; ties broken by slot index (then the
  // occupying strategy index) for a fully deterministic ordering.
  const order = Array.from({ length: N }, (_, s) => s).sort((a, b) => {
    if (result.elimTick[a]! !== result.elimTick[b]!) {
      return result.elimTick[a]! - result.elimTick[b]!;
    }
    if (a !== b) return a - b;
    return result.slotStrategy[a]! - result.slotStrategy[b]!;
  });
  const rankBySlot: number[] = new Array(N).fill(0);
  for (let i = 0; i < order.length; i++) rankBySlot[order[i]!] = i + 1;
  return rankBySlot;
}

/** Right-pad a cell to width. */
function padR(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/** Left-pad a cell to width. */
function padL(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

interface Tally {
  agg: Aggregate[];
  totalMatches: number;
  totalDraws: number;
  totalTiebreaks: number;
  /** Match counter after this schedule (next free seed index). */
  nextIndex: number;
}

/**
 * Run the full C(k,4)-combo × slot-permutation × REPEATS schedule on one map,
 * aggregating per REAL strategy index. `startIndex` seeds the running global
 * match counter so seeds never collide across maps.
 */
function runSchedule(
  mapKind: MapKind,
  combos: number[][],
  permutations: number[][],
  startIndex: number,
): Tally {
  const agg: Aggregate[] = STRATEGIES.map(() => ({
    matches: 0,
    wins: 0,
    survivalSum: 0,
    rankSum: 0,
    draws: 0,
  }));

  let totalDraws = 0;
  let totalTiebreaks = 0;
  let totalMatches = 0;
  let globalMatchIndex = startIndex;

  for (const combo of combos) {
    for (let r = 0; r < REPEATS; r++) {
      for (const permutation of permutations) {
        // slotStrat[s] = REAL strategy index = combo[permutation[s]].
        const slotStrat = permutation.map((pos) => combo[pos]!);
        const result = runMatch(globalMatchIndex, slotStrat, mapKind);
        globalMatchIndex += 1;
        totalMatches += 1;
        const rankBySlot = ranks(result);
        if (result.draw) totalDraws += 1;
        if (result.tiebreak) totalTiebreaks += 1;

        for (let s = 0; s < N; s++) {
          const strat = result.slotStrategy[s]!;
          const a = agg[strat]!;
          a.matches += 1;
          a.survivalSum += result.elimTick[s]!;
          a.rankSum += rankBySlot[s]!;
          if (result.draw) a.draws += 1;
          if (result.winnerStrategy === strat) a.wins += 1;
        }
      }
    }
  }

  return { agg, totalMatches, totalDraws, totalTiebreaks, nextIndex: globalMatchIndex };
}

/** Print one map's result table (rows sorted by win rate desc, then survival). */
function printTable(
  mapKind: MapKind,
  tally: Tally,
  combos: number[][],
  permCount: number,
): void {
  const { agg, totalMatches, totalDraws, totalTiebreaks } = tally;
  const rows = STRATEGIES.map((sdef, idx) => {
    const a = agg[idx]!;
    const winRate = a.matches === 0 ? 0 : a.wins / a.matches;
    const avgSurvival = a.matches === 0 ? 0 : a.survivalSum / a.matches;
    const avgRank = a.matches === 0 ? 0 : a.rankSum / a.matches;
    return {
      name: sdef.name,
      matches: a.matches,
      wins: a.wins,
      winRate,
      avgSurvival,
      avgRank,
      draws: a.draws,
    };
  });
  rows.sort((x, y) => y.winRate - x.winRate || y.avgSurvival - x.avgSurvival);

  const headers = [
    'Strategy',
    'Matches',
    'Wins',
    'WinRate',
    'AvgSurvival',
    'AvgRank',
    'Draws',
  ];
  const cells = rows.map((r) => [
    r.name,
    String(r.matches),
    String(r.wins),
    `${(r.winRate * 100).toFixed(1)}%`,
    r.avgSurvival.toFixed(1),
    r.avgRank.toFixed(2),
    String(r.draws),
  ]);

  const widths = headers.map((h, c) =>
    Math.max(h.length, ...cells.map((row) => row[c]!.length)),
  );

  const fmtRow = (row: string[]): string =>
    row.map((cell, c) => (c === 0 ? padR(cell, widths[c]!) : padL(cell, widths[c]!))).join('  ');

  const sep = widths.map((w) => '-'.repeat(w)).join('  ');

  console.log(
    `[map: ${mapKind}] FFA tournament: C(${STRATEGIES.length},${N})=${combos.length} ` +
      `strategy combos × ${permCount} slot permutations × R=${REPEATS} = ${totalMatches} ` +
      `matches, tick cap ${MAX_TICKS}, ${totalTiebreaks} decided by tiebreak, ` +
      `${totalDraws} true draws`,
  );
  console.log(fmtRow(headers));
  console.log(sep);
  for (const row of cells) console.log(fmtRow(row));
}

function main(): number {
  if (STRATEGIES.length < N) {
    console.error(`tournament needs at least ${N} strategies`);
    return 2;
  }

  const permutations = lexPermutations(N);
  const stratIdxs = Array.from({ length: STRATEGIES.length }, (_, i) => i);
  const combos = combinations(stratIdxs, N); // C(STRATEGIES.length, 4)

  // One full schedule per map; a single running match counter across all maps
  // keeps every match's seed unique while staying fully deterministic.
  let globalMatchIndex = 0;
  for (let mi = 0; mi < MAPS.length; mi++) {
    const tally = runSchedule(MAPS[mi]!, combos, permutations, globalMatchIndex);
    globalMatchIndex = tally.nextIndex;
    if (mi > 0) console.log('');
    printTable(MAPS[mi]!, tally, combos, permutations.length);
  }

  return 0;
}

process.exit(main());
