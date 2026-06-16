/**
 * Behavioral + determinism tests for the AI BotController.
 *
 * These DRIVE the sim (advance ticks) with one NO_INPUT human plus a bot, so
 * they double as a guard that the bot never perturbs the shared RNG: a bot run
 * is bit-reproducible from the same seed (test 1). The rest assert the bot does
 * something useful (survives, clears bricks, drops bombs) without flaking.
 */
import { describe, expect, it } from 'vitest';

import { TileKind } from '../../../shared/types';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { NO_INPUT, type InputFrame } from '../../../client/src/sim/InputBuffer';
import { createInitialState, tick, type SimState } from '../../../client/src/sim/Sim';
import { BotController } from '../../../client/src/ai/v2/BotController';
import { botSeed, tuningFor, type Difficulty } from '../../../client/src/ai/v2/BotConfig';

/** Count SOFT bricks remaining on the map. */
function countSoftBricks(map: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < map.length; i++) {
    if (map[i] === TileKind.SOFT) n += 1;
  }
  return n;
}

describe('BotController determinism', () => {
  it('produces an identical stateHash sequence across two fresh runs', () => {
    const seed = 0x1234abcd;
    const fp = makeFeelParams();

    const runOnce = (): number[] => {
      const controller = new BotController(botSeed(seed, 1), tuningFor('hard'), 1);
      let state: SimState = createInitialState(seed, fp, 2);
      const hashes: number[] = [];
      for (let t = 0; t < 600; t++) {
        const inputs = [NO_INPUT, controller.sample(state, 1)];
        state = tick(state, inputs);
        hashes.push(state.stateHash);
      }
      return hashes;
    };

    const a = runOnce();
    const b = runOnce();
    expect(a).toEqual(b);
  });

  it('produces an identical InputFrame sequence per seed (normal + easy)', () => {
    const seed = 0x55aa33cc;
    const fp = makeFeelParams();

    const runInputs = (diff: Difficulty): InputFrame[] => {
      const controller = new BotController(botSeed(seed, 1), tuningFor(diff), 1);
      let state: SimState = createInitialState(seed, fp, 2);
      const frames: InputFrame[] = [];
      for (let t = 0; t < 300; t++) {
        const frame = controller.sample(state, 1);
        frames.push(frame);
        state = tick(state, [NO_INPUT, frame]);
      }
      return frames;
    };

    for (const diff of ['normal', 'easy'] as const) {
      expect(runInputs(diff)).toEqual(runInputs(diff));
    }
  });
});

describe('BotController behavior', () => {
  const seeds = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666];
  const fp = makeFeelParams();

  it('is not suicidal and makes an impact across a sweep of seeds', () => {
    let anyAliveAt300 = false;
    let anyClearedBricks = false;
    let anyBombFromBot = false;

    for (const seed of seeds) {
      const controller = new BotController(botSeed(seed, 1), tuningFor('hard'), 1);
      let state: SimState = createInitialState(seed, fp, 2);
      const startSoft = countSoftBricks(state.map);
      let aliveAt300 = false;

      for (let t = 0; t < 400; t++) {
        const inputs = [NO_INPUT, controller.sample(state, 1)];
        state = tick(state, inputs);

        if (state.bombs.some((b) => b.ownerSlot === 1)) anyBombFromBot = true;
        if (t === 300) {
          aliveAt300 = state.players.find((p) => p.slot === 1)?.alive ?? false;
        }
      }

      if (aliveAt300) anyAliveAt300 = true;
      if (countSoftBricks(state.map) < startSoft) anyClearedBricks = true;
    }

    expect(anyAliveAt300).toBe(true);
    expect(anyClearedBricks).toBe(true);
    expect(anyBombFromBot).toBe(true);
  });
});
