/**
 * Plain-JS bootstrap for the matrix bench's worker threads.
 *
 * matrix-runner.ts spawns the worker pointed at THIS file (not the .ts worker)
 * because node can run it natively as ESM. It registers tsx's loader in-thread
 * via the programmatic API, then dynamically imports the real TypeScript worker.
 * This is the reliable way to get tsx's ESM hooks active inside a worker on the
 * tsx/node combo here: spawning the .ts worker with `execArgv: ['--import',
 * 'tsx']` fails to resolve nested extensionless `.ts` specifiers, but a
 * programmatic register() followed by a dynamic import does resolve them.
 *
 * workerData (the game shard + agent pool) is thread-global, so matrix-worker.ts
 * still reads it from node:worker_threads exactly as before.
 */
import { register } from 'tsx/esm/api';

register();
await import('./matrix-worker.ts');
