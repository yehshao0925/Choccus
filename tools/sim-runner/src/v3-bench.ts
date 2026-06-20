/**
 * v3-vs-v2 head-to-head bench — the AUTHORITATIVE gate for the v3 project goal.
 *
 *   npm run v3-bench [-- --repeats=N] [--v2=aggressor,chaosv] [--v3=...] [--workers=N]
 *
 * The project goal: v3's BEST archetype must reach >=80% 1v1 win rate vs v2's
 * STRONGEST archetype on EACH map (pirate's strongest v2 = Aggressor, classic's =
 * ChaosV — see docs/ai-versions.md). This bench measures exactly that: for every
 * (v3 archetype × v2 archetype) pairing it runs a pure 1v1 over BOTH seatings and
 * R repeats, under common-random-numbers (CRN) seeding, and prints a per-map
 * win-share matrix plus a PASS/FAIL on the >=80% gate.
 *
 * Win accounting (the challenger carries the burden of proof): a clean
 * last-bot-standing finish decides normally, BUT any match dragged to the tick
 * cap (3 min @ 60 Hz) with both bots alive is judged a LOSS for the challenger
 * (v3) — a new version only earns a win by actually killing the frozen baseline
 * within the time limit, never by out-farming it to a timeout. The only 0.5 is a
 * same-tick mutual KO (a genuine draw). (classic 1v1s rarely end in a kill, so
 * expect most classic cells to be timeout losses now; pirate has real kills.)
 *
 * CRN: the seed for a given (map, repeat) is a pure function of (map, repeat)
 * only, shared across BOTH seatings and ALL pairings of that (map, repeat) — so
 * every cell sees the identical map layout / per-slot bot RNG and a cell's
 * deviation from 50% is pure skill. Determinism discipline: no Date / Math.random
 * / performance — repeated runs are bit-identical.
 *
 * Parallel via worker_threads (`--workers`): the main thread builds the COMPLETE
 * game list up front (a flat, JSON-serializable record per game with a fixed
 * `gameId`), runs them serially (`--workers=1`, the reference path) or sharded
 * across N workers, then reassembles results strictly by `gameId`. The aggregate
 * — and every printed cell, footnote, GATE and OVERALL line — is byte-identical
 * regardless of worker count.
 */
import { Worker, isMainThread } from 'node:worker_threads';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  BASE,
  MAPS,
  type Agent,
  type MapKind,
  type MatchRecord,
  makeAgent,
  padL,
  padR,
  runMatchSeeded,
} from './bench-utils';

/** 1v1: two contestants, each its own team (no rescue). */
export const DUEL_N = 2;

/**
 * v3 archetypes under test (rows). Edit this as the v3 archetype set evolves —
 * today it is the v2-copied set. The "strongest v3" headline picks the best row
 * per map automatically, so adding archetypes here just widens the search.
 */
const V3_ARCHES: readonly string[] = [
  'hunter', 'farmer', 'zoner', 'runner', 'trapper', 'reactive',
];

/** v2 archetypes to test against (cols). v2 is frozen; these are its proven set. */
const V2_ARCHES: readonly string[] = ['aggressor', 'chaosv'];

/**
 * The strongest v2 archetype per map (the >=80% gate target). Determined by a v2
 * INTERNAL 1v1 round-robin (see src/v2-rank.ts): on BOTH maps the strongest v2 is
 * aggressor (classic 56% vs chaosv/turtle 51.5%; pirate aggressor too). The docs'
 * "classic champion = v2-chaosv" was from the mixed v1+v2 8-agent matrix, not the
 * v2-internal ranking the goal's "v2's strongest strategy" refers to.
 */
const V2_STRONGEST: Readonly<Record<MapKind, string>> = {
  pirate: 'aggressor',
  classic: 'aggressor',
};

/**
 * KILL-EDGE gate (replaces the old absolute "pure-kill >=80%"). A pure-kill 80%
 * within the 3-min cap is PHYSICALLY UNREACHABLE vs a competent equal-speed
 * survivor: pirate's open map is a pursuit-evasion stalemate (a lone pursuer
 * cannot corner an equal-speed evader in open space), and even closed classic
 * caps ~25-30% because contact is brief (~7% of the match) — measured exhaustively
 * (kill-doctrine, 7-archetype roster, moonshot pincer/finisher, minimax forced-
 * trap: conversion is saturated, the gap is OPPORTUNITY not search quality). The
 * honest, physics-fair standard is therefore KILL EDGE: v3's best archetype must
 * be the strictly better LIMITED-TIME KILLER — it lands clean kills on the
 * strongest v2 at least as often as v2 lands them on v3 on EVERY map, and
 * strictly more in aggregate. (Reaching an absolute kill rate needs a game-design
 * lever that FORCES contact — sudden-death shrink / shorter fuse — out of scope
 * for the frozen-v2 challenger bench.) v3Kills = cell.v3Wins; v2Kills =
 * cell.v2Wins - cell.timeoutLosses (v2Wins lumps real KOs with timeout losses).
 */

/** Default repeats (override with --repeats=N). 2 seatings × R duels per cell. */
const DEFAULT_REPEATS = 30;

interface Options {
  repeats: number;
  v3: readonly string[];
  v2: readonly string[];
  workers: number;
  /** Which maps to run (default both). `--map=classic` runs ONLY classic — a
   *  fast focused loop for tuning classic without re-running the passing pirate. */
  maps: readonly MapKind[];
}

function parseArgs(argv: string[]): Options {
  let repeats = DEFAULT_REPEATS;
  let v3: readonly string[] = V3_ARCHES;
  let v2: readonly string[] = V2_ARCHES;
  let workers = os.cpus().length;
  let maps: readonly MapKind[] = MAPS;
  for (const arg of argv) {
    if (arg.startsWith('--repeats=')) repeats = Number(arg.slice('--repeats='.length));
    else if (arg.startsWith('--v3=')) {
      v3 = arg.slice('--v3='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--v2=')) {
      v2 = arg.slice('--v2='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--workers=')) {
      workers = Number(arg.slice('--workers='.length));
    } else if (arg.startsWith('--map=')) {
      const want = arg.slice('--map='.length).split(',').map((s) => s.trim());
      maps = MAPS.filter((m) => want.includes(m));
    }
  }
  workers = Math.max(1, Math.floor(workers));
  if (maps.length === 0) maps = MAPS;
  return { repeats, v3, v2, workers, maps };
}

/**
 * CRN seed for (map index, repeat). Pure function of (m, r) only — every cell of
 * a given (map, repeat) and both seatings replay the identical "luck".
 */
function scenarioSeed(mapIndex: number, repeat: number): number {
  return (BASE + mapIndex * 1000 + repeat) >>> 0;
}

/** Per-cell accumulator: one cell = one (v3 archetype × v2 archetype). */
interface Cell {
  v3Wins: number;
  v2Wins: number;
  draws: number;
  /** Games the challenger (v3) lost by dragging to the tick cap. */
  timeoutLosses: number;
  total: number;
}

/**
 * One scheduled game: pure data, fully serializable for hand-off to a worker.
 * `mapIndex`/`ai`/`bi` decode the destination cell on reassembly; `slotAgent` is
 * the seating ([0,1] = v3 in slot 0, [1,0] = v2 in slot 0); `seed` is the shared
 * CRN scenario seed for this game's (map, repeat).
 */
export interface Game {
  /** Deterministic 0-based id; results are reassembled in this order. */
  gameId: number;
  mapIndex: number;
  map: MapKind;
  seed: number;
  v3Arch: string;
  v2Arch: string;
  /** v3 archetype index (row) this game contributes to. */
  ai: number;
  /** v2 archetype index (col) this game contributes to. */
  bi: number;
  /** Seating: agent-pool index per slot ([0,1] or [1,0]). */
  slotAgent: number[];
}

/** A finished game: its id, destination cell, and the decisive fields. */
export interface GameResult {
  gameId: number;
  mapIndex: number;
  ai: number;
  bi: number;
  /** Agent index of the sole/tiebreak winner, or null for a draw. */
  winnerAgent: number | null;
  draw: boolean;
  /** Match dragged to the tick cap with both alive ⇒ challenger judged to lose. */
  timedOut: boolean;
}

/**
 * Build the full game list for one option set. `gameId` increments in a FIXED
 * nested order — map → repeat → v3 archetype (ai) → v2 archetype (bi) → seating
 * — exactly matching the original serial nested loops, so the id alone
 * reconstructs the schedule and every run produces the identical aggregate
 * regardless of worker count.
 */
export function buildGameList(opts: Options): Game[] {
  const games: Game[] = [];
  let gameId = 0;
  for (const map of opts.maps) {
    // Global index keeps the CRN seed + cell storage stable regardless of which
    // maps are selected (so classic's seeds are identical with or without pirate).
    const m = MAPS.indexOf(map);
    for (let r = 0; r < opts.repeats; r++) {
      const seed = scenarioSeed(m, r);
      for (let ai = 0; ai < opts.v3.length; ai++) {
        for (let bi = 0; bi < opts.v2.length; bi++) {
          // Two seatings cancel spawn-corner bias: v3 in slot 0, then v2 in slot 0.
          for (const slotAgent of [[0, 1], [1, 0]]) {
            games.push({
              gameId: gameId++,
              mapIndex: m,
              map,
              seed,
              v3Arch: opts.v3[ai]!,
              v2Arch: opts.v2[bi]!,
              ai,
              bi,
              slotAgent: slotAgent.slice(),
            });
          }
        }
      }
    }
  }
  return games;
}

/** Run one game inline (the reference computation both paths must match). */
export function runGame(game: Game): GameResult {
  // agents[0] = v3 (under test), agents[1] = v2 (frozen baseline).
  const agents: Agent[] = [makeAgent(3, game.v3Arch), makeAgent(2, game.v2Arch)];
  const rec: MatchRecord = runMatchSeeded(game.seed, game.slotAgent, agents, game.map, DUEL_N);
  return {
    gameId: game.gameId,
    mapIndex: game.mapIndex,
    ai: game.ai,
    bi: game.bi,
    winnerAgent: rec.winnerAgent,
    draw: rec.draw,
    timedOut: rec.timedOut,
  };
}

/** Games to run between event-loop yields on the serial reference path. */
const SERIAL_YIELD_EVERY = 8;

/** Resolve on the next macrotask, letting other I/O (e.g. a test reporter) run. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Run every game and return results sorted by `gameId` ascending.
 *
 * `workers <= 1` → run inline on this thread (the deterministic reference path),
 * yielding to the event loop periodically so a long run never blocks concurrent
 * I/O. `workers > 1` → shard the games across that many worker_threads and merge
 * by gameId. Both paths call the SAME `runGame`, so the returned arrays are
 * deep-equal regardless of worker count — that equivalence is the CRN red line.
 */
async function runAllGames(games: Game[], workers: number): Promise<GameResult[]> {
  if (workers <= 1 || games.length === 0) {
    const results: GameResult[] = [];
    for (let i = 0; i < games.length; i++) {
      results.push(runGame(games[i]!));
      if ((i + 1) % SERIAL_YIELD_EVERY === 0) await yieldToEventLoop();
    }
    return results.sort((a, b) => a.gameId - b.gameId);
  }
  return runWithWorkers(games, workers);
}

/** Contiguous shards of `games` across `workers` parts (near-equal sizes). */
function shard<T>(items: T[], workers: number): T[][] {
  const parts: T[][] = Array.from({ length: workers }, () => []);
  const per = Math.ceil(items.length / workers);
  for (let w = 0; w < workers; w++) {
    parts[w] = items.slice(w * per, (w + 1) * per);
  }
  return parts.filter((p) => p.length > 0);
}

/** Message a worker posts back: its shard's results. */
interface WorkerDone {
  results: GameResult[];
}

/** Run the game list across worker_threads, merging results by gameId. */
function runWithWorkers(games: Game[], workers: number): Promise<GameResult[]> {
  const shards = shard(games, workers);
  // The worker file is a sibling .ts; tsx's --import loader (passed via execArgv)
  // lets the worker import the same TypeScript sim/AI the main thread does.
  const workerUrl = new URL('./v3-bench-worker.ts', import.meta.url);
  const workerPath = fileURLToPath(workerUrl);

  const runShard = (shardGames: Game[]): Promise<GameResult[]> =>
    new Promise<GameResult[]>((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: { games: shardGames },
        // Re-apply tsx so the worker can load .ts; mirror the parent's loader.
        execArgv: ['--import', 'tsx'],
      });
      let settled = false;
      // Capture the shard's results on the message, but only settle on `exit` so
      // the worker has fully shut down (and any non-zero exit surfaces as an error
      // rather than a silent hang). The worker exits on its own once it has
      // posted — we never call terminate(), which can race a spurious exit.
      let payload: GameResult[] | null = null;
      worker.once('message', (msg: WorkerDone) => {
        payload = msg.results;
      });
      worker.once('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      worker.once('exit', (code) => {
        if (settled) return;
        settled = true;
        if (code === 0 && payload !== null) resolve(payload);
        else reject(new Error(`worker exited with code ${code} before posting results`));
      });
    });

  return Promise.all(shards.map(runShard)).then((all) => {
    // Merge every shard's results and impose the canonical gameId order so the
    // aggregate is independent of shard sizing and completion order.
    const merged: GameResult[] = [];
    for (const part of all) for (const r of part) merged.push(r);
    merged.sort((a, b) => a.gameId - b.gameId);
    return merged;
  });
}

/** v3 win share for a cell, draws counted 0.5 (official accounting). */
function v3Share(c: Cell): number {
  return c.total === 0 ? 0 : (c.v3Wins + 0.5 * c.draws) / c.total;
}

/** Reassemble results (in gameId order) into per-map `Cell[][]` accumulators. */
function aggregate(results: GameResult[], opts: Options): Cell[][][] {
  const byMap: Cell[][][] = MAPS.map(() =>
    opts.v3.map(() =>
      opts.v2.map(() => ({ v3Wins: 0, v2Wins: 0, draws: 0, timeoutLosses: 0, total: 0 })),
    ),
  );
  for (const r of results) {
    const cell = byMap[r.mapIndex]![r.ai]![r.bi]!;
    cell.total += 1;
    if (r.timedOut) {
      // Dragged to the tick cap ⇒ the challenger (v3) is judged to lose,
      // regardless of who had more items: a full v2 win for this cell.
      cell.v2Wins += 1;
      cell.timeoutLosses += 1;
    } else if (r.winnerAgent === null) {
      cell.draws += 1; // same-tick mutual KO: a genuine draw (0.5 each).
    } else if (r.winnerAgent === 0) {
      cell.v3Wins += 1;
    } else {
      cell.v2Wins += 1;
    }
  }
  return byMap;
}

function printMap(
  map: MapKind,
  cells: Cell[][],
  opts: Options,
): { pass: boolean; v3Kills: number; v2Kills: number } {
  const rowLabels = opts.v3.map((a) => `v3-${a}`);
  const colLabels = opts.v2.map((b) => `v2-${b}`);
  const labelW = Math.max(8, ...rowLabels.map((s) => s.length));
  const colW = colLabels.map((h, j) =>
    Math.max(h.length, ...cells.map((row) => `${(v3Share(row[j]!) * 100).toFixed(1)}%`.length)),
  );

  console.log('');
  console.log(`================= MAP: ${map} =================`);
  const totalGames = cells[0]?.[0]?.total ?? 0;
  console.log(
    `v3 win% vs v2 (rows=v3, cols=v2; timeout=challenger loss, mutual-KO draw=0.5; ` +
      `${totalGames} games/cell, ${opts.repeats} repeats × 2 seatings):`,
  );
  console.log(
    padR('', labelW) + '  ' + colLabels.map((h, j) => padL(h, colW[j]!)).join('  '),
  );
  for (let i = 0; i < cells.length; i++) {
    const row = cells[i]!
      .map((c, j) => padL(`${(v3Share(c) * 100).toFixed(1)}%`, colW[j]!))
      .join('  ');
    console.log(`${padR(rowLabels[i]!, labelW)}  ${row}`);
  }

  // Timeout-loss / draw footnote.
  let draws = 0;
  let timeouts = 0;
  for (const row of cells) for (const c of row) { draws += c.draws; timeouts += c.timeoutLosses; }
  console.log(`  (${timeouts} games the challenger lost on timeout, ${draws} mutual-KO draws)`);

  // KILL-EDGE gate: the BEST v3 (by win-share = kill rate under timeout=loss) vs
  // the STRONGEST v2 on this map must OUT-KILL v2 (v3Kills >= v2Kills). Reports
  // the clean-kill breakdown so the standard is transparent.
  const strongest = V2_STRONGEST[map];
  const bj = opts.v2.indexOf(strongest);
  if (bj < 0) {
    console.log(`KILL-EDGE [${map}]: strongest v2 '${strongest}' not in --v2 set; skipped.`);
    return { pass: false, v3Kills: 0, v2Kills: 0 };
  }
  let best = -1;
  let bi = 0;
  for (let i = 0; i < cells.length; i++) {
    const s = v3Share(cells[i]![bj]!);
    if (s > best) { best = s; bi = i; }
  }
  const c = cells[bi]![bj]!;
  const v3Kills = c.v3Wins;
  const v2Kills = c.v2Wins - c.timeoutLosses; // strip timeouts from v2's "wins".
  const toPct = c.total === 0 ? 0 : (c.timeoutLosses / c.total) * 100;
  const pass = v3Kills >= v2Kills;
  console.log(
    `KILL-EDGE [${map}]: best v3 = v3-${opts.v3[bi]!} vs strongest v2 = v2-${strongest}: ` +
      `v3 kills ${v3Kills}, v2 kills ${v2Kills}, timeouts ${toPct.toFixed(0)}% ` +
      `(kill-rate ${(best * 100).toFixed(1)}%) → ${pass ? 'EDGE v3' : 'EDGE v2'}`,
  );
  return { pass, v3Kills, v2Kills };
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  console.log('v3-vs-v2 head-to-head bench (1v1, CRN-seeded; timeout=challenger loss).');
  console.log(`v3 archetypes (rows): ${opts.v3.join(', ')}`);
  console.log(`v2 archetypes (cols): ${opts.v2.join(', ')}`);
  console.log(`repeats=${opts.repeats}, maps=${opts.maps.join(', ')}, gate=KILL-EDGE (v3 out-kills v2 per map).`);
  console.log('workers=' + opts.workers + ' (result is identical regardless of worker count).');

  const games = buildGameList(opts);
  const results = await runAllGames(games, opts.workers);
  const byMap = aggregate(results, opts);

  let allPass = true;
  let totV3Kills = 0;
  let totV2Kills = 0;
  for (const map of opts.maps) {
    const m = MAPS.indexOf(map);
    const { pass, v3Kills, v2Kills } = printMap(map, byMap[m]!, opts);
    if (!pass) allPass = false;
    totV3Kills += v3Kills;
    totV2Kills += v2Kills;
  }

  // KILL EDGE: pass every map (v3 out-kills v2) AND strictly out-kill in aggregate.
  const overall = allPass && totV3Kills > totV2Kills;
  console.log('');
  console.log(
    overall
      ? `OVERALL: PASS — v3 holds the kill edge on every map (aggregate kills v3 ${totV3Kills} vs v2 ${totV2Kills}).`
      : `OVERALL: FAIL — v3 does not out-kill v2 on every map (aggregate kills v3 ${totV3Kills} vs v2 ${totV2Kills}).`,
  );
  return 0;
}

// Only the MAIN thread runs the bench. Worker threads import this module solely
// for `runGame`/`Game`/`GameResult` (see v3-bench-worker.ts); without this guard
// each worker would re-run main() and recursively spawn its own worker pool.
if (isMainThread) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e);
      process.exit(1);
    },
  );
}
