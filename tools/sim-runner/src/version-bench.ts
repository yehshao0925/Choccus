/**
 * Version bot bench: is one AI version STRONGER than another in a 4-bot FFA?
 *
 *   npm run version-bench
 *
 * We pit two AI versions against each other via the version registry
 * (client/src/ai/index.ts), defaulting to the previous version vs the latest
 * (e.g. v1 vs v2). To isolate DECISION LOGIC from tuning, each contestant of one
 * version shares its archetype (and thus its tuning numbers) with a same-named
 * contestant of the other version — both ask their own version module for the
 * same archetype key, so only the version's code path differs. The four FIXED
 * contestants are:
 *   vOld-Aggressor (old version + aggressor archetype)
 *   vNew-Aggressor (new version + aggressor archetype)
 *   vOld-ChaosV    (old version + chaosv archetype)
 *   vNew-ChaosV    (new version + chaosv archetype)
 *
 * Each bot plays in its OWN team (teams = [0,1,2,3], pvp), so there is NO
 * teammate rescue — it is a straight last-bot-standing FFA. For each map we run
 * all 4!=24 lexicographic slot permutations of the four contestants over the
 * four corners (removing positional bias), repeated R times: 24×R matches per
 * map. A single running GLOBAL match counter feeds every seed across both maps
 * so seeds never collide.
 *
 * Timeout rule (cap reached with >1 bot alive): the CHALLENGER (new version) is
 * judged to lose — only an OLD-version survivor can take the tick-cap win (by the
 * most pickups: fire + cannon + speed). If only new-version bots survive to the
 * cap it's a genuine draw. A new version must KILL within the time limit to win.
 *
 * Pure orchestration: no Date / Math.random / performance — every seed is
 * derived from the running GLOBAL match counter, so repeated runs are
 * bit-identical.
 */
import { GamePhase } from '../../../shared/types';
import {
  MATCH_MAX_TICKS,
  PLAYER_START_CANNON,
  PLAYER_START_FIRE,
  PLAYER_START_SPEED_BONUS,
} from '../../../shared/constants';
import {
  AI_VERSIONS,
  type BotSpec,
  type IBotController,
  LATEST_AI_VERSION,
} from '../../../client/src/ai/index';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { type InputFrame } from '../../../client/src/sim/InputBuffer';
import { type PlayerState } from '../../../client/src/sim/Player';
import {
  tick,
  createInitialState,
  type SimState,
} from '../../../client/src/sim/Sim';

/** FFA player count = the fixed number of spawn corners and contestants. */
const N = 4;
/** Times the full 24-permutation slate is replayed per map. 24×R matches/map. */
const R = 4;
/** Per-match tick cap (3 min @ 60 Hz); the sim itself also forces OVER here. */
const MAX_TICKS = MATCH_MAX_TICKS;
/** Base match seed; per-match seed = (BASE + globalMatchIndex) >>> 0. */
const BASE = 0x12345678;
/** Map layouts the bench evaluates, each printed as its own table. */
type MapKind = 'classic' | 'pirate';
const MAPS: readonly MapKind[] = ['classic', 'pirate'];

/** The two versions compared: previous vs latest (e.g. v1 vs v2). */
const NEW_VERSION = LATEST_AI_VERSION;
const OLD_VERSION = LATEST_AI_VERSION - 1;
/** Difficulty is ignored when a strategy archetype is set; kept for the spec. */
const DIFFICULTY = 'normal';

/**
 * A fixed contestant: a name, the AI version it runs, and its archetype key
 * (which resolves to that version's tuning). Same-archetype old/new pairs carry
 * identical numeric knobs, so a win-rate gap reflects pure decision-logic
 * differences between the two versions.
 */
interface Contestant {
  name: string;
  version: number;
  /** ?strategy= archetype key fed to the version module (selects the tuning). */
  archetype: string;
}

/** The four FIXED contestants. Index = contestant id used throughout. */
const CONTESTANTS: readonly Contestant[] = [
  { name: `v${OLD_VERSION}-Aggressor`, version: OLD_VERSION, archetype: 'aggressor' },
  { name: `v${NEW_VERSION}-Aggressor`, version: NEW_VERSION, archetype: 'aggressor' },
  { name: `v${OLD_VERSION}-ChaosV`, version: OLD_VERSION, archetype: 'chaosv' },
  { name: `v${NEW_VERSION}-ChaosV`, version: NEW_VERSION, archetype: 'chaosv' },
];

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

interface MatchResult {
  /** Elimination tick per slot (end tick if the slot survived). */
  elimTick: number[];
  /** Contestant id occupying each slot this match. */
  slotContestant: number[];
  /** Contestant id of the sole winner, or null for a draw. */
  winnerContestant: number | null;
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

/** Build the controller for `contestant` at `slot` with the match's seed. */
function makeController(
  contestant: Contestant,
  seed: number,
  slot: number,
): IBotController {
  const spec: BotSpec = { difficulty: DIFFICULTY, strategyRaw: contestant.archetype };
  return AI_VERSIONS[contestant.version]!.createBot(seed, slot, spec);
}

/**
 * Run one FFA match and return per-slot survival + winner info.
 * `slotCon[s]` is the contestant id (0..3) occupying slot/corner s this match.
 * `globalMatchIndex` is the running match counter used to derive the
 * deterministic per-match seed.
 */
function runMatch(
  globalMatchIndex: number,
  slotCon: number[],
  mapKind: MapKind,
): MatchResult {
  const seed = (BASE + globalMatchIndex) >>> 0;
  const teams = [0, 1, 2, 3].slice(0, N); // each bot its own team: pure FFA.
  let state: SimState = createInitialState(seed, makeFeelParams(), N, {
    pvp: true,
    teams,
    map: mapKind,
  });

  const controllers: IBotController[] = [];
  for (let s = 0; s < N; s++) {
    controllers.push(makeController(CONTESTANTS[slotCon[s]!]!, seed, s));
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
    winnerContestant = slotCon[aliveSlots[0]!]!;
    draw = false;
  } else if (aliveSlots.length > 1) {
    // Tick-cap timeout: the CHALLENGER (new version) is judged to lose — a new
    // version only earns a win by an actual kill, never by out-farming to the
    // cap. Restrict the item tiebreak to OLD-version survivors; if none survive
    // (only new-version bots left), it's a genuine draw.
    const oldSurvivors = aliveSlots.filter(
      (s) => CONTESTANTS[slotCon[s]!]!.version === OLD_VERSION,
    );
    let winSlot: number | null = null;
    if (oldSurvivors.length === 1) winSlot = oldSurvivors[0]!;
    else if (oldSurvivors.length > 1) winSlot = tiebreakWinner(state, oldSurvivors);
    if (winSlot !== null) {
      winnerContestant = slotCon[winSlot]!;
      draw = false;
      tiebreak = true;
    }
  }

  return {
    elimTick,
    slotContestant: slotCon.slice(),
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

/** Derive per-slot rank (1 = died first ... N = survived longest). */
function ranks(result: MatchResult): number[] {
  // Sort slots by elimination tick asc; ties broken by slot index (then the
  // occupying contestant id) for a fully deterministic ordering.
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
  agg: Aggregate[];
  totalMatches: number;
  totalDraws: number;
  totalTiebreaks: number;
  /** Match counter after this schedule (next free seed index). */
  nextIndex: number;
}

/**
 * Run all 24 slot permutations × R on one map, aggregating per CONTESTANT id.
 * `startIndex` seeds the running global match counter so seeds never collide
 * across maps.
 */
function runSchedule(
  mapKind: MapKind,
  permutations: number[][],
  startIndex: number,
): Tally {
  const agg: Aggregate[] = CONTESTANTS.map(() => ({
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

  for (let r = 0; r < R; r++) {
    for (const permutation of permutations) {
      // slotCon[s] = contestant id occupying slot s = permutation[s].
      const slotCon = permutation.slice();
      const result = runMatch(globalMatchIndex, slotCon, mapKind);
      globalMatchIndex += 1;
      totalMatches += 1;
      const rankBySlot = ranks(result);
      if (result.draw) totalDraws += 1;
      if (result.tiebreak) totalTiebreaks += 1;

      for (let s = 0; s < N; s++) {
        const con = result.slotContestant[s]!;
        const a = agg[con]!;
        a.matches += 1;
        a.survivalSum += result.elimTick[s]!;
        a.rankSum += rankBySlot[s]!;
        if (result.draw) a.draws += 1;
        if (result.winnerContestant === con) a.wins += 1;
      }
    }
  }

  return { agg, totalMatches, totalDraws, totalTiebreaks, nextIndex: globalMatchIndex };
}

interface Row {
  name: string;
  matches: number;
  wins: number;
  winRate: number;
  avgSurvival: number;
  avgRank: number;
}

/** Build per-contestant rows (id-indexed) from a tally's aggregates. */
function rowsOf(tally: Tally): Row[] {
  return CONTESTANTS.map((c, idx) => {
    const a = tally.agg[idx]!;
    return {
      name: c.name,
      matches: a.matches,
      wins: a.wins,
      winRate: a.matches === 0 ? 0 : a.wins / a.matches,
      avgSurvival: a.matches === 0 ? 0 : a.survivalSum / a.matches,
      avgRank: a.matches === 0 ? 0 : a.rankSum / a.matches,
    };
  });
}

/** Format a signed number with an explicit leading + or -. */
function signed(v: number, digits: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(digits);
}

/** Print one map's result table (rows sorted by win rate desc, then survival). */
function printTable(mapKind: MapKind, tally: Tally, rows: Row[]): void {
  const { totalMatches, totalDraws, totalTiebreaks } = tally;
  const sorted = rows
    .slice()
    .sort((x, y) => y.winRate - x.winRate || y.avgSurvival - x.avgSurvival);

  const headers = ['Contestant', 'Matches', 'Wins', 'WinRate', 'AvgSurvival', 'AvgRank'];
  const cells = sorted.map((r) => [
    r.name,
    String(r.matches),
    String(r.wins),
    `${(r.winRate * 100).toFixed(1)}%`,
    r.avgSurvival.toFixed(1),
    r.avgRank.toFixed(2),
  ]);

  const widths = headers.map((h, c) =>
    Math.max(h.length, ...cells.map((row) => row[c]!.length)),
  );

  const fmtRow = (row: string[]): string =>
    row.map((cell, c) => (c === 0 ? padR(cell, widths[c]!) : padL(cell, widths[c]!))).join('  ');

  const sep = widths.map((w) => '-'.repeat(w)).join('  ');

  console.log(
    `[map: ${mapKind}] version FFA: ${CONTESTANTS.length} contestants × ` +
      `4!=24 slot permutations × R=${R} = ${totalMatches} matches, tick cap ` +
      `${MAX_TICKS}, ${totalTiebreaks} won on old-version timeout tiebreak ` +
      `(new version loses on timeout), ${totalDraws} true draws`,
  );
  console.log(fmtRow(headers));
  console.log(sep);
  for (const row of cells) console.log(fmtRow(row));
}

/**
 * Print the two vNew-vs-vOld comparison lines (positive = the new version is
 * stronger). ΔWinRate is in percentage points; ΔAvgRank uses AvgRank (higher =
 * survived longer = stronger), so a positive Δ means the new version is
 * stronger than the old one.
 */
function printComparisons(rows: Row[]): void {
  const byName = (name: string): Row => rows.find((r) => r.name === name)!;
  for (const archetype of ['Aggressor', 'ChaosV']) {
    const vNew = byName(`v${NEW_VERSION}-${archetype}`);
    const vOld = byName(`v${OLD_VERSION}-${archetype}`);
    const dWin = (vNew.winRate - vOld.winRate) * 100;
    const dRank = vNew.avgRank - vOld.avgRank;
    console.log(
      `v${NEW_VERSION} vs v${OLD_VERSION} ${archetype}: ` +
        `ΔWinRate=${signed(dWin, 1)}%, ΔAvgRank=${signed(dRank, 2)}`,
    );
  }
}

function main(): number {
  console.log(
    `Comparing AI v${NEW_VERSION} (latest) vs v${OLD_VERSION} via the version ` +
      'registry. Same archetype = identical tuning on both sides, so any gap is ' +
      'pure decision-logic difference between the two versions.',
  );

  const permutations = lexPermutations(N);

  // One full schedule per map; a single running match counter across all maps
  // keeps every match's seed unique while staying fully deterministic.
  let globalMatchIndex = 0;
  for (let mi = 0; mi < MAPS.length; mi++) {
    const tally = runSchedule(MAPS[mi]!, permutations, globalMatchIndex);
    globalMatchIndex = tally.nextIndex;
    const rows = rowsOf(tally);
    if (mi > 0) console.log('');
    printTable(MAPS[mi]!, tally, rows);
    printComparisons(rows);
  }

  return 0;
}

process.exit(main());
