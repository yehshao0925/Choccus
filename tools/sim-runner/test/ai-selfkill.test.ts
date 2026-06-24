/**
 * Regression guard for the AI BotController's self-preservation.
 *
 * History: bots used to validate a long escape route when DROPPING a bomb but
 * only START fleeing within a tiny FLEE_HORIZON, and — worse — would casually
 * walk into the lingering melt-flow of their own just-detonated bomb. The result
 * was bots blowing THEMSELVES up the overwhelming majority of the time (see
 * baseline numbers in src/selfkill.ts header / the task report). This test pins
 * the self-trap rate low so that regression cannot creep back, while also
 * asserting the bot stays aggressive (it must still bomb foes and clear bricks).
 *
 * Measurement is fully deterministic (the bot carries its own RNG; the sim is
 * pure) — see src/selfkill.ts for how OWN-bomb traps are attributed without
 * touching any sim state structure.
 */
import { describe, expect, it } from 'vitest';

import { TileKind } from '../../../shared/types';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { createInitialState, tick, type SimState } from '../../../client/src/sim/Sim';
import { BotController } from '../../../client/src/ai/v5/BotController';
import { botSeed, tuningFor, type Difficulty } from '../../../client/src/ai/v5/BotConfig';
import { measureSelfTrapRate } from '../src/selfkill';
import { yieldToEventLoop } from '../src/async-yield';

const SEED_START = 1;
const SEED_COUNT = 80;

// Self-trap-rate ceilings (fraction of bots that blow THEMSELVES up at least
// once across a ~10-bomb-cycle window). normal/hard must be comfortably single
// digit; easy is allowed a little more because it keeps a small DELIBERATE
// reckless-bomb chance to feel fallible. Generous headroom over the measured
// values (easy ~3-5%, normal ~2-3%, hard ~4-5%) so the test is not flaky.
const SELF_TRAP_CEILING: Readonly<Record<Difficulty, number>> = {
  easy: 0.12,
  normal: 0.08,
  hard: 0.08,
};

describe('BotController self-trap rate stays low (regression guard)', () => {
  for (const d of ['easy', 'normal', 'hard'] as const) {
    it(`${d}: < ${(SELF_TRAP_CEILING[d] * 100).toFixed(0)}% of bots self-trap`, async () => {
      const s = await measureSelfTrapRate(d, SEED_START, SEED_COUNT);
      expect(s.botsSelfTrappedRate).toBeLessThan(SELF_TRAP_CEILING[d]);
    });
  }

  it('the measurement is deterministic (same seeds → identical tally)', async () => {
    const a = await measureSelfTrapRate('hard', SEED_START, 20);
    const b = await measureSelfTrapRate('hard', SEED_START, 20);
    expect(a).toEqual(b);
  });
});

describe('BotController stays aggressive (not over-conservative)', () => {
  const fp = makeFeelParams();

  it('bombs actively and clears soft bricks across a 2-team sweep', async () => {
    let bombsPlaced = 0;
    let softCleared = 0;

    for (let seed = SEED_START; seed < SEED_START + 30; seed++) {
      await yieldToEventLoop(); // between independent matches; result-neutral
      let state: SimState = createInitialState(seed, fp, 4, {
        teams: [0, 1, 0, 1],
      });
      const controllers = state.players.map(
        (p) => new BotController(botSeed(seed, p.slot), tuningFor('normal'), p.slot),
      );
      const countSoft = (m: Uint8Array): number => {
        let n = 0;
        for (const t of m) if (t === TileKind.SOFT) n += 1;
        return n;
      };
      const softBefore = countSoft(state.map as Uint8Array);

      for (let t = 0; t < 1200; t++) {
        const inputs = state.players.map((p) =>
          controllers[p.slot]!.sample(state, p.slot),
        );
        const before = state.bombs.length;
        state = tick(state, inputs);
        if (state.bombs.length > before) bombsPlaced += state.bombs.length - before;
        if (state.phase !== 1) break;
      }
      softCleared += softBefore - countSoft(state.map as Uint8Array);
    }

    expect(bombsPlaced).toBeGreaterThan(100);
    expect(softCleared).toBeGreaterThan(100);
  });
});
