/**
 * worker_threads entry for the v3-bench's parallel path.
 *
 * Loaded by v3-bench.ts via `new Worker(workerPath, { execArgv:
 * ['--import', 'tsx'] })` so this .ts file (and the sim/AI it pulls in) runs
 * under tsx inside the worker. It receives a shard of games in `workerData`, runs
 * each game with the SAME `runGame` the serial path uses, and posts the results
 * back. No per-shard order assumption: the main thread re-sorts everything by
 * gameId, so this worker may finish in any order.
 *
 * Determinism: each game is a fresh `runMatchSeeded` with its own state and
 * controllers; nothing mutable is shared across games or across threads.
 */
import { parentPort, workerData } from 'node:worker_threads';

import { type Game, type GameResult, runGame } from './v3-bench';

interface WorkerInput {
  games: Game[];
}

const { games } = workerData as WorkerInput;

const results: GameResult[] = games.map((g) => runGame(g));

// parentPort is non-null inside a worker; guard for the type-checker only.
parentPort?.postMessage({ results });
