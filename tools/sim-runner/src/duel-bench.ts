/**
 * Duel bot bench: is the newest AI version STRONGER than the previous one in a
 * head-to-head 1v1, across EVERY archetype pairing?
 *
 *   npm run duel-bench
 *
 * Where version-bench answers "is the new version stronger?" inside a 4-bot FFA,
 * this bench drills into the cleanest possible signal: a pure 1v1 DUEL between
 * two AI versions (defaulting to the previous version vs the latest, e.g. v1 vs
 * v2), run for ALL ordered archetype pairings via the version registry
 * (client/src/ai/index.ts). We sweep a full 4×4 matrix:
 *   rows = the OLD version's archetype
 *   cols = the NEW version's archetype
 *   cell = NEW-version win% in that pairing (decisive matches only)
 * over both maps, so any cell answers "does vNew-B beat vOld-A?" directly.
 *
 * The four archetypes are aggressor / turtle / gambler / chaosv. Each archetype
 * resolves to a tuning via each version's own module; both sides ask for the
 * same archetype key, so the two carry identical numeric knobs and a cell's
 * deviation from 50% reflects pure decision-logic differences, not tuning.
 *
 * Each duel is N=2 with teams=[0,1] (each bot its own team, pvp), so there is NO
 * teammate rescue — it is a straight last-bot-standing 1v1. To remove corner
 * bias every cell aggregates BOTH seatings (old in slot 0 / new in slot 0), and
 * the whole schedule is replayed R times. A single running GLOBAL match counter
 * feeds every seed across both maps, all cells, both seatings and all R, so
 * seeds never collide.
 *
 * Draw tiebreak (cap reached with both bots alive): the survivor that collected
 * the most pickups (fire + cannon + speed) wins; exact ties stay a genuine draw.
 * Mirrors tournament.ts / version-bench `tiebreakWinner`.
 *
 * Pure orchestration: no Date / Math.random / performance — every seed is
 * derived from the running GLOBAL match counter, so repeated runs are
 * bit-identical.
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

/** Duel player count = the two contestants (one old version, one new). */
const N = 2;
/** Times the full matrix×seating slate is replayed. */
const R = 8;
/** Per-match tick cap; a match hitting this without a winner is a draw. */
const MAX_TICKS = 10800; // 3 min @ 60 Hz (= shared MATCH_MAX_TICKS)
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
 * An archetype: a display name plus the ?strategy= key that selects its tuning.
 * The matrix iterates archetypes in this FIXED order (rows = old, cols = new).
 */
interface Archetype {
  /** Short, table-friendly display name (column/row header). */
  name: string;
  /** ?strategy= archetype key fed to each version module (selects the tuning). */
  key: string;
}

/** The four archetypes in FIXED order. Index = archetype id used throughout. */
const ARCHETYPES: readonly Archetype[] = [
  { name: 'Aggressor', key: 'aggressor' },
  { name: 'Turtle', key: 'turtle' },
  { name: 'Gambler', key: 'gambler' },
  { name: 'ChaosV', key: 'chaosv' },
];

/**
 * All permutations of [0..n-1] in lexicographic order (deterministic, no RNG).
 * Not needed for the 1v1 matrix (seatings are enumerated explicitly), but kept
 * to mirror version-bench's style and stay drop-in if N ever grows.
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

/** Right-pad a cell to width. */
function padR(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/** Left-pad a cell to width. */
function padL(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

/**
 * One seating of a 1v1 duel: which slot holds the old-version bot and which
 * holds the new-version bot, plus each side's archetype key. `oldSlot`/`newSlot`
 * are {0,1} disjoint.
 */
interface Seating {
  oldSlot: number;
  newSlot: number;
  oldKey: string;
  newKey: string;
}

/** Outcome of one duel, attributed to the new or the old version side. */
interface DuelResult {
  /** True when the NEW-version bot won this duel. */
  newWin: boolean;
  /** True when the OLD-version bot won this duel. */
  oldWin: boolean;
  /** True when neither won (genuine draw). */
  draw: boolean;
  /** True when the winner was decided by the tick-cap item tiebreak. */
  tiebreak: boolean;
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

/**
 * Run one 1v1 duel for the given seating and map, returning the new/old
 * attribution. `globalMatchIndex` is the running match counter used to derive
 * the deterministic per-match seed.
 */
function runDuel(
  globalMatchIndex: number,
  seating: Seating,
  mapKind: MapKind,
): DuelResult {
  const seed = (BASE + globalMatchIndex) >>> 0;
  const teams = [0, 1]; // each bot its own team: pure 1v1, no rescue.
  let state: SimState = createInitialState(seed, makeFeelParams(), N, {
    pvp: true,
    teams,
    map: mapKind,
  });

  const controllers: IBotController[] = new Array(N);
  controllers[seating.oldSlot] = makeController(
    OLD_VERSION,
    seating.oldKey,
    seed,
    seating.oldSlot,
  );
  controllers[seating.newSlot] = makeController(
    NEW_VERSION,
    seating.newKey,
    seed,
    seating.newSlot,
  );

  while (state.phase === GamePhase.PLAYING && state.tick < MAX_TICKS) {
    const frame: InputFrame[] = [];
    for (let s = 0; s < N; s++) frame.push(controllers[s]!.sample(state, s));
    state = tick(state, frame);
  }

  const aliveSlots: number[] = [];
  for (let s = 0; s < N; s++) if (state.players[s]!.alive) aliveSlots.push(s);

  let winnerSlot: number | null = null;
  let tiebreak = false;
  if (state.phase === GamePhase.OVER && aliveSlots.length === 1) {
    // Clean last-bot-standing finish.
    winnerSlot = aliveSlots[0]!;
  } else if (aliveSlots.length > 1) {
    // Hit the tick cap with both alive: break the tie on item progress.
    const winSlot = tiebreakWinner(state, aliveSlots);
    if (winSlot !== null) {
      winnerSlot = winSlot;
      tiebreak = true;
    }
  }

  if (winnerSlot === null) {
    return { newWin: false, oldWin: false, draw: true, tiebreak: false };
  }
  const newWin = winnerSlot === seating.newSlot;
  return { newWin, oldWin: !newWin, draw: false, tiebreak };
}

/** Per-cell accumulator: one cell = one (old archetype A) × (new archetype B). */
interface Cell {
  newWins: number;
  oldWins: number;
  draws: number;
  tiebreaks: number;
}

/** Aggregated result of a full per-map schedule. */
interface MapTally {
  /** cell[a][b] = duels with old archetype a vs new archetype b. */
  cells: Cell[][];
  totalNewWins: number;
  totalOldWins: number;
  totalDraws: number;
  totalTiebreaks: number;
  /** Match counter after this schedule (next free seed index). */
  nextIndex: number;
}

/**
 * Run the full 4×4 matrix on one map: for every (old archetype a, new archetype
 * b) cell, run BOTH seatings × R duels. `startIndex` seeds the running global
 * match counter so seeds never collide across maps. Iteration order is fixed.
 */
function runSchedule(mapKind: MapKind, startIndex: number): MapTally {
  const A = ARCHETYPES.length;
  const cells: Cell[][] = ARCHETYPES.map(() =>
    ARCHETYPES.map(() => ({ newWins: 0, oldWins: 0, draws: 0, tiebreaks: 0 })),
  );

  let totalNewWins = 0;
  let totalOldWins = 0;
  let totalDraws = 0;
  let totalTiebreaks = 0;
  let globalMatchIndex = startIndex;

  for (let r = 0; r < R; r++) {
    for (let a = 0; a < A; a++) {
      for (let b = 0; b < A; b++) {
        const oldKey = ARCHETYPES[a]!.key;
        const newKey = ARCHETYPES[b]!.key;
        // Two seatings to cancel corner bias: old in slot 0, then new in slot 0.
        const seatings: Seating[] = [
          { oldSlot: 0, newSlot: 1, oldKey, newKey },
          { oldSlot: 1, newSlot: 0, oldKey, newKey },
        ];
        for (const seating of seatings) {
          const result = runDuel(globalMatchIndex, seating, mapKind);
          globalMatchIndex += 1;
          const cell = cells[a]![b]!;
          if (result.draw) {
            cell.draws += 1;
            totalDraws += 1;
          } else if (result.newWin) {
            cell.newWins += 1;
            totalNewWins += 1;
          } else {
            cell.oldWins += 1;
            totalOldWins += 1;
          }
          if (result.tiebreak) {
            cell.tiebreaks += 1;
            totalTiebreaks += 1;
          }
        }
      }
    }
  }

  return {
    cells,
    totalNewWins,
    totalOldWins,
    totalDraws,
    totalTiebreaks,
    nextIndex: globalMatchIndex,
  };
}

/**
 * Print one map's NEW-version win-rate matrix: rows = old archetype, cols = new
 * archetype, each cell = NEW win% = newWins / (newWins + oldWins) * 100
 * (draws excluded from the denominator; an all-draw cell prints "n/a").
 */
function printMatrix(mapKind: MapKind, tally: MapTally): void {
  const A = ARCHETYPES.length;
  const totalDuels =
    tally.totalNewWins + tally.totalOldWins + tally.totalDraws;
  const decisive = tally.totalNewWins + tally.totalOldWins;

  const cellStr = (c: Cell): string => {
    const dec = c.newWins + c.oldWins;
    return dec === 0 ? 'n/a' : `${((c.newWins / dec) * 100).toFixed(1)}%`;
  };

  // Column header is the new archetype; row label is the old archetype.
  const rowLabel = (name: string): string => `v${OLD_VERSION}-${name}`;
  const corner = `v${OLD_VERSION} \\ v${NEW_VERSION}`;

  const colHeaders = ARCHETYPES.map((c) => c.name);
  const dataRows = ARCHETYPES.map((_rowArc, a) =>
    ARCHETYPES.map((_colArc, b) => cellStr(tally.cells[a]![b]!)),
  );

  // First column width spans the corner label and all row labels.
  const labelW = Math.max(
    corner.length,
    ...ARCHETYPES.map((c) => rowLabel(c.name).length),
  );
  // Each data column spans its header and all its cells.
  const colW = colHeaders.map((h, b) =>
    Math.max(h.length, ...dataRows.map((row) => row[b]!.length)),
  );

  console.log(
    `[map: ${mapKind}] 1v1 duel matrix: ${A}×${A} archetype pairings × ` +
      `2 seatings × R=${R} = ${totalDuels} duels, tick cap ${MAX_TICKS}, ` +
      `${tally.totalTiebreaks} decided by tiebreak, ${tally.totalDraws} true draws`,
  );
  console.log(
    `cell = v${NEW_VERSION} win% vs v${OLD_VERSION}; >50% = new version stronger; ` +
      '(draws excluded from denominator)',
  );

  const headerLine = [padR(corner, labelW), ...colHeaders.map((h, b) => padL(h, colW[b]!))].join('  ');
  console.log(headerLine);
  const sep = [
    '-'.repeat(labelW),
    ...colW.map((w) => '-'.repeat(w)),
  ].join('  ');
  console.log(sep);

  for (let a = 0; a < A; a++) {
    const line = [
      padR(rowLabel(ARCHETYPES[a]!.name), labelW),
      ...dataRows[a]!.map((cell, b) => padL(cell, colW[b]!)),
    ].join('  ');
    console.log(line);
  }

  const newRate = decisive === 0 ? 0 : (tally.totalNewWins / decisive) * 100;
  console.log(
    `[map: ${mapKind}] overall v${NEW_VERSION} win rate: ${newRate.toFixed(1)}% ` +
      `(${tally.totalNewWins}/${decisive} decisive), ${tally.totalDraws} draws, ` +
      `${tally.totalTiebreaks} tiebreak-decided`,
  );
}

function main(): number {
  console.log(
    `Comparing AI v${NEW_VERSION} (latest) vs v${OLD_VERSION} via the version ` +
      'registry, 1v1 across every archetype pairing. Same archetype = identical ' +
      "tuning on both sides, so a cell's deviation from 50% is pure decision-logic.",
  );

  // Touch lexPermutations so the mirrored helper is exercised (and not dead).
  void lexPermutations(N);

  let globalMatchIndex = 0;
  let combinedNewWins = 0;
  let combinedDecisive = 0;
  let combinedDraws = 0;
  for (let mi = 0; mi < MAPS.length; mi++) {
    const tally = runSchedule(MAPS[mi]!, globalMatchIndex);
    globalMatchIndex = tally.nextIndex;
    if (mi > 0) console.log('');
    printMatrix(MAPS[mi]!, tally);
    combinedNewWins += tally.totalNewWins;
    combinedDecisive += tally.totalNewWins + tally.totalOldWins;
    combinedDraws += tally.totalDraws;
  }

  const combinedRate =
    combinedDecisive === 0 ? 0 : (combinedNewWins / combinedDecisive) * 100;
  console.log('');
  console.log(
    `[both maps] overall v${NEW_VERSION}-vs-v${OLD_VERSION} win rate: ` +
      `${combinedRate.toFixed(1)}% (${combinedNewWins}/${combinedDecisive} ` +
      `decisive), ${combinedDraws} draws`,
  );

  return 0;
}

process.exit(main());
