import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The AI self-trap / head-to-head guards run many full 60 Hz matches with
    // the live bot. The v2 bot (AI_VERSION 2) replaces the single weighted
    // scoring pass with a depth-limited forward-model search + 3-scenario
    // maximin survivability, which is several times heavier per tick. The
    // heaviest guards drive 80 seeds × 4 live bots × up to 1800-tick matches
    // (and the strategies guard does that 4× over), so a single `it` can run a
    // few minutes wall-clock. Give a generous ceiling so these correctness
    // guards never flake on a loaded machine while still catching a genuine
    // infinite hang. (Self-trap rates measure ~0% — the cost is runtime, not
    // safety; see forwardSearch.ts for the depth/node-cap perf notes.)
    testTimeout: 600000,
  },
});
