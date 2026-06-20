/**
 * Cross-version 3-phase AI bench: is AI v2 stronger than AI v1?
 *
 *   npm run cross-version-bench
 *
 * Where duel-bench drills the cleanest 1v1 signal and version-bench replays a
 * same-version FFA, THIS bench answers the headline question via a 3-phase
 * play-off, all in a single 4-bot FFA format:
 *
 *   Phase A: rank v1's four archetypes in a 4-bot FFA -> pick its strongest 2.
 *   Phase B: rank v2's four archetypes in a 4-bot FFA -> pick its strongest 2.
 *   Phase C: put v1's top-2 + v2's top-2 in one 4-bot FFA -> compare the
 *            combined win rate of the two v1 bots vs the two v2 bots.
 *
 * Every phase runs the SAME schedule: four fixed contestants over four spawn
 * corners, enumerating all 4!=24 lexicographic slot permutations (cancels
 * positional/corner bias), repeated R=2 times, on BOTH maps:
 *   24 perms x R=2 x 2 maps = 96 matches per phase (printed as the actual count).
 *
 * Bots are built through the version registry (client/src/ai/index.ts), NOT a
 * pinned import, so each contestant carries its own AI version's decision logic:
 *   AI_VERSIONS[version].createBot(seed, slot, { difficulty:'normal',
 *     strategyRaw: archetypeKey })
 *
 * Each contestant plays in its OWN team (no teammate rescue). Selection of the
 * top 2 in A/B uses the COMBINED-across-maps win rate (tiebreak avgSurvival
 * desc), mirroring tournament.ts's sort.
 *
 * Draw tiebreak (cap reached with >1 bot alive): the survivor that collected the
 * most pickups (fire + cannon + speed) wins; exact ties stay a genuine draw.
 * Mirrors tournament.ts / duel-bench `tiebreakWinner`.
 *
 * Pure orchestration: no Date / Math.random / performance. Every per-match seed
 * is derived from a single running GLOBAL match counter shared across ALL phases
 * and both maps, so seeds never collide and repeated runs are bit-identical.
 */
import { GamePhase } from '../../../shared/types';
import {
  PLAYER_START_CANNON,
  PLAYER_START_FIRE,
  PLAYER_START_SPEED_BONUS,
} from '../../../shared/constants';
import {
  AI_VERSIONS,
  type BotSpec,
  type IBotController,
} from '../../../client/src/ai/index';
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
/** Times each slot permutation is replayed. 24 perms x R=2 = 48 matches per map. */
const REPEATS = 2;
/** Per-match tick cap; a match hitting this without a winner is a draw. */
const MAX_TICKS = 10800; // 3 min @ 60 Hz (= shared MATCH_MAX_TICKS)
/** Base match seed; per-match seed = (BASE + globalMatchIndex) >>> 0. */
const BASE = 0x12345678;
/** Difficulty is ignored when a strategy archetype is set; kept for the spec. */
const DIFFICULTY = 'normal';
/** Map layouts the bench evaluates, each printed as its own breakdown. */
type MapKind = 'classic' | 'pirate';
const MAPS: readonly MapKind[] = ['classic', 'pirate'];

/** The four archetype keys, same as duel-bench, in FIXED order. */
const ARCHETYPE_KEYS: readonly string[] = ['aggressor', 'turtle', 'gambler', 'chaosv'];

/** Capitalize an archetype key for display ('aggressor' -> 'Aggressor'). */
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * A contestant: an AI version paired with an archetype key, plus a clear label
 * like "v1-Aggressor" used in every table. Results aggregate per contestant
 * identity (its index in the per-phase contestant array).
 */
interface Contestant {
  version: number;
  archetypeKey: string;
  label: string;
}

/** Build a contestant with an auto-derived "v<V>-<Archetype>" label. */
function contestant(version: number, archetypeKey: string): Contestant {
  return {
    version,
    archetypeKey,
    label: `v${version}-${capitalize(archetypeKey)}`,
  };
}

/**
 * All permutations of [0..n-1] in lexicographic order (deterministic, no RNG).
 * Used to rotate which contestant sits in which slot/corner across matches.
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

/** Build a controller for a slot from an AI version and archetype key. */
function makeController(
  version: number,
  archetypeKey: string,
  seed: number,
  slot: number,
): IBotController {
  const spec: BotSpec = { difficulty: DIFFICULTY, strategyRaw: archetypeKey };
  return AI_VERSIONS[version]!.createBot(seed, slot, spec);
}

interface MatchResult {
  /** Elimination tick per slot (end tick if the slot survived). */
  elimTick: number[];
  /** Contestant index occupying each slot this match. */
  slotContestant: number[];
  /** Contestant index of the sole/tiebreak winner, or null for a draw. */
  winnerContestant: number | null;
  draw: boolean;
  /** True when the winner was decided by the tick-cap item tiebreak. */
  tiebreak: boolean;
}

/**
 * Run one FFA match and return per-slot survival + winner info.
 * `slotContestant[s]` is the contestant index occupying slot/corner s this
 * match; `contestants` maps that index to a `Contestant`. `globalMatchIndex` is
 * the running match counter used to derive the deterministic per-match seed.
 */
function runMatch(
  globalMatchIndex: number,
  slotContestant: number[],
  contestants: Contestant[],
  mapKind: MapKind,
): MatchResult {
  const seed = (BASE + globalMatchIndex) >>> 0;
  const teams = [0, 1, 2, 3].slice(0, N);
  let state: SimState = createInitialState(seed, makeFeelParams(), N, {
    pvp: true,
    teams,
    map: mapKind,
  });

  const controllers: IBotController[] = [];
  for (let s = 0; s < N; s++) {
    const c = contestants[slotContestant[s]!]!;
    controllers.push(makeController(c.version, c.archetypeKey, seed, s));
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

  let winnerContestant: number | null = null;
  let draw = true;
  let tiebreak = false;
  if (state.phase === GamePhase.OVER && aliveSlots.length === 1) {
    // Clean last-bot-standing finish.
    winnerContestant = slotContestant[aliveSlots[0]!]!;
    draw = false;
  } else if (aliveSlots.length > 1) {
    // Hit the tick cap with multiple survivors: break the tie on item progress.
    const winSlot = tiebreakWinner(state, aliveSlots);
    if (winSlot !== null) {
      winnerContestant = slotContestant[winSlot]!;
      draw = false;
      tiebreak = true;
    }
  }

  return {
    elimTick,
    slotContestant: slotContestant.slice(),
    winnerContestant,
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

function emptyAgg(): Aggregate {
  return { matches: 0, wins: 0, survivalSum: 0, rankSum: 0, draws: 0 };
}

/** Derive per-slot rank (1 = died first ... N = survived longest). */
function ranks(result: MatchResult): number[] {
  // Sort slots by elimination tick asc; ties broken by slot index (then the
  // occupying contestant index) for a fully deterministic ordering.
  const order = Array.from({ length: N }, (_, s) => s).sort((a, b) => {
    if (result.elimTick[a]! !== result.elimTick[b]!) {
      return result.elimTick[a]! - result.elimTick[b]!;
    }
    if (a !== b) return a - b;
    return result.slotContestant[a]! - result.slotContestant[b]!;
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
  /** agg[i] = aggregate for contestant index i. */
  agg: Aggregate[];
  totalMatches: number;
  totalDraws: number;
  totalTiebreaks: number;
  /** Match counter after this schedule (next free seed index). */
  nextIndex: number;
}

/**
 * Run the full 24-permutation × REPEATS schedule on one map, aggregating per
 * contestant index. `startIndex` seeds the running global match counter so
 * seeds never collide across maps/phases.
 */
function runSchedule(
  contestants: Contestant[],
  mapKind: MapKind,
  permutations: number[][],
  startIndex: number,
): Tally {
  const agg: Aggregate[] = contestants.map(() => emptyAgg());

  let totalDraws = 0;
  let totalTiebreaks = 0;
  let totalMatches = 0;
  let globalMatchIndex = startIndex;

  for (let r = 0; r < REPEATS; r++) {
    for (const permutation of permutations) {
      // slotContestant[s] = contestant index occupying slot s = permutation[s].
      const slotContestant = permutation.slice();
      const result = runMatch(globalMatchIndex, slotContestant, contestants, mapKind);
      globalMatchIndex += 1;
      totalMatches += 1;
      const rankBySlot = ranks(result);
      if (result.draw) totalDraws += 1;
      if (result.tiebreak) totalTiebreaks += 1;

      for (let s = 0; s < N; s++) {
        const ci = result.slotContestant[s]!;
        const a = agg[ci]!;
        a.matches += 1;
        a.survivalSum += result.elimTick[s]!;
        a.rankSum += rankBySlot[s]!;
        if (result.draw) a.draws += 1;
        if (result.winnerContestant === ci) a.wins += 1;
      }
    }
  }

  return {
    agg,
    totalMatches,
    totalDraws,
    totalTiebreaks,
    nextIndex: globalMatchIndex,
  };
}

/** A printable per-contestant row, with derived rates. */
interface Row {
  ci: number;
  label: string;
  matches: number;
  wins: number;
  winRate: number;
  avgSurvival: number;
  avgRank: number;
  draws: number;
}

/** Build rows from a tally, sorted by winRate desc then avgSurvival desc. */
function rowsFromTally(contestants: Contestant[], tally: Tally): Row[] {
  const rows: Row[] = contestants.map((c, ci) => {
    const a = tally.agg[ci]!;
    const winRate = a.matches === 0 ? 0 : a.wins / a.matches;
    const avgSurvival = a.matches === 0 ? 0 : a.survivalSum / a.matches;
    const avgRank = a.matches === 0 ? 0 : a.rankSum / a.matches;
    return {
      ci,
      label: c.label,
      matches: a.matches,
      wins: a.wins,
      winRate,
      avgSurvival,
      avgRank,
      draws: a.draws,
    };
  });
  rows.sort((x, y) => y.winRate - x.winRate || y.avgSurvival - x.avgSurvival);
  return rows;
}

/** Print a per-contestant table from pre-sorted rows. */
function printRows(title: string, rows: Row[]): void {
  const headers = [
    'Contestant',
    'Matches',
    'Wins',
    'WinRate',
    'AvgSurvival',
    'AvgRank',
    'Draws',
  ];
  const cells = rows.map((r) => [
    r.label,
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

  console.log(title);
  console.log(fmtRow(headers));
  console.log(sep);
  for (const row of cells) console.log(fmtRow(row));
}

/** Sum two tallies' per-contestant aggregates (same contestant ordering). */
function mergeTally(a: Tally, b: Tally): Tally {
  const agg: Aggregate[] = a.agg.map((ag, i) => {
    const bg = b.agg[i]!;
    return {
      matches: ag.matches + bg.matches,
      wins: ag.wins + bg.wins,
      survivalSum: ag.survivalSum + bg.survivalSum,
      rankSum: ag.rankSum + bg.rankSum,
      draws: ag.draws + bg.draws,
    };
  });
  return {
    agg,
    totalMatches: a.totalMatches + b.totalMatches,
    totalDraws: a.totalDraws + b.totalDraws,
    totalTiebreaks: a.totalTiebreaks + b.totalTiebreaks,
    nextIndex: Math.max(a.nextIndex, b.nextIndex),
  };
}

/** Result of running one full phase (both maps) over a contestant set. */
interface PhaseResult {
  contestants: Contestant[];
  perMap: { map: MapKind; tally: Tally }[];
  combined: Tally;
  /** Combined-across-maps rows, sorted for selection. */
  combinedRows: Row[];
  /** Match counter after this phase (next free seed index). */
  nextIndex: number;
}

/**
 * Run a phase: the full 96-match schedule (24 perms × R=2 × 2 maps) over the
 * given contestants, printing per-map breakdowns and the combined table used
 * for selection. `startIndex` continues the running global match counter.
 */
function runPhase(
  header: string,
  contestants: Contestant[],
  permutations: number[][],
  startIndex: number,
): PhaseResult {
  console.log('');
  console.log(`=== ${header} ===`);
  console.log(
    `Contestants: ${contestants.map((c) => c.label).join(', ')}`,
  );

  let globalMatchIndex = startIndex;
  const perMap: { map: MapKind; tally: Tally }[] = [];
  let combined: Tally | null = null;

  for (const map of MAPS) {
    const tally = runSchedule(contestants, map, permutations, globalMatchIndex);
    globalMatchIndex = tally.nextIndex;
    perMap.push({ map, tally });
    combined = combined === null ? tally : mergeTally(combined, tally);

    const rows = rowsFromTally(contestants, tally);
    console.log('');
    printRows(
      `[map: ${map}] ${contestants.length}-bot FFA: ${permutations.length} ` +
        `slot permutations × R=${REPEATS} = ${tally.totalMatches} matches, ` +
        `tick cap ${MAX_TICKS}, ${tally.totalTiebreaks} decided by tiebreak, ` +
        `${tally.totalDraws} true draws`,
      rows,
    );
  }

  const combinedTally = combined!;
  const combinedRows = rowsFromTally(contestants, combinedTally);
  console.log('');
  printRows(
    `[both maps COMBINED] used for top-2 selection — ${combinedTally.totalMatches} ` +
      `matches, ${combinedTally.totalTiebreaks} tiebreak-decided, ` +
      `${combinedTally.totalDraws} true draws (sorted by WinRate desc, then AvgSurvival desc)`,
    combinedRows,
  );

  return {
    contestants,
    perMap,
    combined: combinedTally,
    combinedRows,
    nextIndex: globalMatchIndex,
  };
}

function main(): number {
  const permutations = lexPermutations(N); // 24
  const matchesPerPhase = permutations.length * REPEATS * MAPS.length;

  console.log(
    'Cross-version AI bench: is AI v2 stronger than AI v1? 3-phase 4-bot FFA ' +
      'play-off via the version registry (client/src/ai/index.ts).',
  );
  console.log(
    `Each phase = ${permutations.length} slot permutations × R=${REPEATS} × ` +
      `${MAPS.length} maps = ${matchesPerPhase} matches. Top-2 picked on the ` +
      'combined-across-maps WinRate (tiebreak AvgSurvival desc).',
  );

  // Verify the four archetype keys resolve via each version's module before any
  // match runs (createBot throws/falls back on unknown keys — surface early).
  for (const v of [1, 2]) {
    for (const key of ARCHETYPE_KEYS) {
      const spec: BotSpec = { difficulty: DIFFICULTY, strategyRaw: key };
      // Touch createBot + botNameFor so a bad key is caught up front.
      void AI_VERSIONS[v]!.createBot((BASE + 0) >>> 0, 0, spec);
      void AI_VERSIONS[v]!.botNameFor(0, spec);
    }
  }

  let globalMatchIndex = 0;

  // --- Phase A: rank v1's four archetypes. ---
  const phaseAContestants = ARCHETYPE_KEYS.map((k) => contestant(1, k));
  const phaseA = runPhase(
    'PHASE A: v1 ranking',
    phaseAContestants,
    permutations,
    globalMatchIndex,
  );
  globalMatchIndex = phaseA.nextIndex;
  const v1Top2 = phaseA.combinedRows.slice(0, 2).map((r) => phaseAContestants[r.ci]!);

  // --- Phase B: rank v2's four archetypes. ---
  const phaseBContestants = ARCHETYPE_KEYS.map((k) => contestant(2, k));
  const phaseB = runPhase(
    'PHASE B: v2 ranking',
    phaseBContestants,
    permutations,
    globalMatchIndex,
  );
  globalMatchIndex = phaseB.nextIndex;
  const v2Top2 = phaseB.combinedRows.slice(0, 2).map((r) => phaseBContestants[r.ci]!);

  console.log('');
  console.log(
    `Phase A -> v1 top 2: ${v1Top2.map((c) => c.label).join(', ')}`,
  );
  console.log(
    `Phase B -> v2 top 2: ${v2Top2.map((c) => c.label).join(', ')}`,
  );

  // --- Phase C: v1 top-2 + v2 top-2 in one 4-bot FFA. ---
  // Contestant order: [v1-A1, v1-A2, v2-B1, v2-B2]; indices 0,1 = v1 side.
  const phaseCContestants = [v1Top2[0]!, v1Top2[1]!, v2Top2[0]!, v2Top2[1]!];
  const phaseC = runPhase(
    'PHASE C: v1 top-2 vs v2 top-2',
    phaseCContestants,
    permutations,
    globalMatchIndex,
  );
  globalMatchIndex = phaseC.nextIndex;

  // Side aggregates: contestants 0,1 are v1; 2,3 are v2.
  const cAgg = phaseC.combined.agg;
  const v1Wins = cAgg[0]!.wins + cAgg[1]!.wins;
  const v2Wins = cAgg[2]!.wins + cAgg[3]!.wins;
  const v1Matches = cAgg[0]!.matches + cAgg[1]!.matches;
  const v2Matches = cAgg[2]!.matches + cAgg[3]!.matches;
  const v1Rate = v1Matches === 0 ? 0 : (v1Wins / v1Matches) * 100;
  const v2Rate = v2Matches === 0 ? 0 : (v2Wins / v2Matches) * 100;

  // Verdict thresholds: within 2 combined wins (across 96 matches) = "roughly
  // even"; otherwise the higher total wins is the stronger side.
  let verdict: string;
  if (Math.abs(v1Wins - v2Wins) <= 2) {
    verdict = 'roughly even';
  } else if (v2Wins > v1Wins) {
    verdict = 'v2 side stronger';
  } else {
    verdict = 'v1 side stronger';
  }

  console.log('');
  console.log(
    `[PHASE C SUMMARY] v1 side (${phaseCContestants[0]!.label}+${phaseCContestants[1]!.label}): ` +
      `${v1Wins} wins / ${v1Matches} contestant-matches = ${v1Rate.toFixed(1)}%  |  ` +
      `v2 side (${phaseCContestants[2]!.label}+${phaseCContestants[3]!.label}): ` +
      `${v2Wins} wins / ${v2Matches} contestant-matches = ${v2Rate.toFixed(1)}%`,
  );
  console.log(`[PHASE C SUMMARY] verdict: ${verdict}`);

  console.log('');
  console.log('========================= VERDICT =========================');
  console.log(`v1 top 2: ${v1Top2.map((c) => c.label).join(', ')}`);
  console.log(`v2 top 2: ${v2Top2.map((c) => c.label).join(', ')}`);
  console.log(
    `Phase C v1 side: ${v1Wins} wins (${v1Rate.toFixed(1)}%)  vs  ` +
      `v2 side: ${v2Wins} wins (${v2Rate.toFixed(1)}%)`,
  );
  console.log(`=> ${verdict}`);
  console.log('===========================================================');

  return 0;
}

process.exit(main());
