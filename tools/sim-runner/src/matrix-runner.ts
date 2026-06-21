/**
 * Game-list builder + parallel/serial runner for the matrix bench.
 *
 * The main thread builds the COMPLETE game list up front — every game is a flat,
 * JSON-serializable record `{ gameId, mapKind, seed, slot0Agent, slot1Agent }`.
 * `runAllGames` then executes them and returns results reassembled into a fixed
 * `gameId` order, so the aggregate is byte-for-byte identical whether the games
 * ran on one thread or were sharded across N workers (the CRN red line).
 *
 * Two paths, ONE result:
 *  - workers ≤ 1  → reference path: run every game inline on this thread.
 *  - workers > 1  → split the game list across worker_threads, each running its
 *                   shard with the SAME runMatchSeeded, then merge by gameId.
 *
 * CRN seeding: `scenarioSeed(map, repeat)` is a pure function of (map, repeat)
 * only — NOT of the pairing or direction — so all 28 pairings of a given
 * (map, repeat) replay under the identical seed (same layout, same per-slot bot
 * RNG), and forward/reverse seatings share it too. That is the common-random-
 * numbers variance reduction: a cell's deviation from 50% is pure skill, not
 * luck. No Date / Math.random / performance anywhere.
 */
import { Worker } from 'node:worker_threads';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  BASE,
  MAPS,
  type Agent,
  type MapKind,
  type MatchRecord,
  combinations,
  runMatchSeeded,
} from './bench-utils';

/** 1v1: two contestants, each its own team (no rescue). */
export const DUEL_N = 2;

/**
 * CRN scenario seed for (map index, repeat). Depends ONLY on (m, r) so every
 * pairing of a given (map, repeat) — both seatings — replays the identical
 * "luck". `m` is the index into MAPS, `r` the repeat in [0, repeats).
 */
export function scenarioSeed(mapIndex: number, repeat: number): number {
  return (BASE + mapIndex * 5 + repeat) >>> 0;
}

/**
 * One scheduled game: pure data, fully serializable for hand-off to a worker.
 * `slot0Agent` / `slot1Agent` are indices into the agent pool; `seed` is the
 * shared CRN scenario seed for this game's (map, repeat).
 */
export interface Game {
  /** Deterministic 0-based id; results are reassembled in this order. */
  gameId: number;
  mapKind: MapKind;
  seed: number;
  /** Agent-pool index seated in slot 0. */
  slot0Agent: number;
  /** Agent-pool index seated in slot 1. */
  slot1Agent: number;
  /** Optional per-match tick cap (serialized to workers). Undefined → the real
   *  3-min default; the determinism tests set a short value for speed. */
  maxTicks?: number;
}

/** A finished game: its id plus the raw MatchRecord (all numbers/arrays). */
export interface GameResult {
  gameId: number;
  record: MatchRecord;
}

/**
 * Build the full game list for `agents`: every unordered pair × both seatings ×
 * each map × each repeat. `gameId` increments in a FIXED nested order so the id
 * alone reconstructs (map, pairIndex, repeat, direction) for reassembly and
 * every run produces the identical schedule.
 *
 * Order (outer→inner): map, pair, repeat, direction(forward, reverse). Forward =
 * agent i in slot 0; reverse = agent j in slot 0 (cancels spawn-corner bias).
 */
export function buildGameList(
  agents: Agent[],
  repeats: number,
  maxTicks?: number,
  maps: readonly MapKind[] = MAPS,
): Game[] {
  const n = agents.length;
  const pairs = combinations(
    Array.from({ length: n }, (_, i) => i),
    2,
  );

  const games: Game[] = [];
  let gameId = 0;
  // Iterate the GLOBAL map index m so scenarioSeed(m, r) is identical whether or
  // not a map is filtered out — CRN stays byte-stable vs a full run.
  for (let m = 0; m < MAPS.length; m++) {
    const mapKind = MAPS[m]!;
    if (!maps.includes(mapKind)) continue;
    for (const [i, j] of pairs) {
      for (let r = 0; r < repeats; r++) {
        const seed = scenarioSeed(m, r);
        // Forward: i in slot 0, j in slot 1.
        games.push({ gameId: gameId++, mapKind, seed, slot0Agent: i!, slot1Agent: j!, maxTicks });
        // Reverse: same seed, seats swapped.
        games.push({ gameId: gameId++, mapKind, seed, slot0Agent: j!, slot1Agent: i!, maxTicks });
      }
    }
  }
  return games;
}

/** Run one game inline (the reference computation both paths must match). */
export function runGame(game: Game, agents: Agent[]): GameResult {
  const record = runMatchSeeded(
    game.seed,
    [game.slot0Agent, game.slot1Agent],
    agents,
    game.mapKind,
    DUEL_N,
    game.maxTicks,
  );
  return { gameId: game.gameId, record };
}

/** Options for runAllGames. `workers <= 1` forces the serial reference path. */
export interface RunOptions {
  workers?: number;
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
 * `workers <= 1` → run inline on this thread (the deterministic reference path).
 * `workers > 1`  → shard the games across that many worker_threads and merge by
 * gameId. Both paths call the SAME `runMatchSeeded`, so the returned arrays are
 * deep-equal regardless of worker count — that equivalence is the CRN guard the
 * tests pin.
 *
 * The serial path runs each game to completion in fixed gameId order (results are
 * bit-identical to a plain loop) but yields to the event loop every few games:
 * a long synchronous grind would otherwise starve any concurrent I/O — including
 * a test runner's progress-reporting heartbeat — for tens of seconds. Yielding
 * only interleaves macrotasks BETWEEN whole games, so it never changes a result.
 */
export async function runAllGames(
  games: Game[],
  agents: Agent[],
  opts: RunOptions = {},
): Promise<GameResult[]> {
  const requested = opts.workers ?? os.cpus().length;
  const workers = Math.max(1, Math.floor(requested));

  if (workers <= 1 || games.length === 0) {
    // Reference path: pure serial, no threads. Run in fixed order, yielding the
    // event loop periodically so a long run never blocks concurrent I/O.
    const results: GameResult[] = [];
    for (let i = 0; i < games.length; i++) {
      results.push(runGame(games[i]!, agents));
      if ((i + 1) % SERIAL_YIELD_EVERY === 0) await yieldToEventLoop();
    }
    return results.sort((a, b) => a.gameId - b.gameId);
  }

  return runWithWorkers(games, agents, workers);
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

/** Message a worker posts back: its shard's results (id + record each). */
interface WorkerDone {
  results: GameResult[];
}

/** Run the game list across worker_threads, merging results by gameId. */
function runWithWorkers(
  games: Game[],
  agents: Agent[],
  workers: number,
): Promise<GameResult[]> {
  const shards = shard(games, workers);
  // The worker runs TypeScript (matrix-worker.ts + the sim/AI it pulls in), so
  // the worker thread needs tsx's ESM hooks. Passing `execArgv: ['--import',
  // 'tsx']` is the documented way, but on this tsx/node combo those hooks don't
  // resolve nested extensionless `.ts` specifiers inside a worker. So we point
  // the Worker at a plain-JS bootstrap node runs natively, which registers tsx's
  // loader programmatically and then dynamically imports the real .ts worker —
  // that path DOES resolve the project's extensionless imports.
  const bootUrl = new URL('./matrix-worker-boot.mjs', import.meta.url);
  const bootPath = fileURLToPath(bootUrl);

  const runShard = (shardGames: Game[]): Promise<GameResult[]> =>
    new Promise<GameResult[]>((resolve, reject) => {
      const worker = new Worker(bootPath, {
        workerData: { games: shardGames, agents },
      });
      let settled = false;
      // Capture the shard's results on the message, but only settle on `exit`
      // so the worker has fully shut down (and any non-zero exit surfaces as an
      // error rather than a silent hang). The worker exits on its own once it
      // has posted — we never call terminate(), which can race a spurious exit.
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
