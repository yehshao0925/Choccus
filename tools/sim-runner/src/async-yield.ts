/**
 * Hand the event loop back between chunks of a long synchronous test loop.
 *
 * The AI regression guards run many full 60 Hz matches in a single tight `for`
 * loop. That work is pure and CPU-bound, so while it runs the worker's event
 * loop is blocked and vitest's reporter RPC (`onTaskUpdate`) can't be serviced —
 * which trips a "Timeout calling onTaskUpdate" error and fails the run even
 * though every assertion passes. Awaiting this between independent per-seed
 * matches lets the heartbeat through. It only interleaves macrotasks BETWEEN
 * whole matches, so it never changes a result (each match is a pure function of
 * its seed). Mirrors the same trick in matrix-runner's serial path.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
