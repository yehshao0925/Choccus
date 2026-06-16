import { describe, expect, it } from 'vitest';

import {
  DIFFICULTY_PRESETS,
  botRandFloat,
  botSeed,
  parseDifficulty,
  tuningFor,
} from '../../../client/src/ai/v2/BotConfig';

describe('DIFFICULTY_PRESETS', () => {
  it('has easy/normal/hard keys', () => {
    expect(Object.keys(DIFFICULTY_PRESETS).sort()).toEqual([
      'easy',
      'hard',
      'normal',
    ]);
  });

  it('reactionDelayTicks is monotonic easy > normal > hard', () => {
    const { easy, normal, hard } = DIFFICULTY_PRESETS;
    expect(easy.reactionDelayTicks).toBeGreaterThan(normal.reactionDelayTicks);
    expect(normal.reactionDelayTicks).toBeGreaterThan(hard.reactionDelayTicks);
  });

  it('mistakeChance is monotonic easy > normal > hard', () => {
    const { easy, normal, hard } = DIFFICULTY_PRESETS;
    expect(easy.mistakeChance).toBeGreaterThan(normal.mistakeChance);
    expect(normal.mistakeChance).toBeGreaterThan(hard.mistakeChance);
  });

  it('bombChance is monotonic easy < normal < hard', () => {
    const { easy, normal, hard } = DIFFICULTY_PRESETS;
    expect(easy.bombChance).toBeLessThan(normal.bombChance);
    expect(normal.bombChance).toBeLessThan(hard.bombChance);
  });
});

describe('parseDifficulty', () => {
  it('parses valid values', () => {
    expect(parseDifficulty('easy')).toBe('easy');
    expect(parseDifficulty('EASY')).toBe('easy');
    expect(parseDifficulty('hard')).toBe('hard');
  });

  it('defaults to normal for null and garbage', () => {
    expect(parseDifficulty(null)).toBe('normal');
    expect(parseDifficulty('garbage')).toBe('normal');
  });
});

describe('tuningFor', () => {
  it('falls back to the normal tuning for unknown input', () => {
    expect(tuningFor('???' as never)).toEqual(DIFFICULTY_PRESETS.normal);
  });
});

describe('botSeed', () => {
  it('is reproducible for the same input', () => {
    expect(botSeed(12345, 0)).toBe(botSeed(12345, 0));
  });

  it('produces distinct values for slots 0/1/2', () => {
    const a = botSeed(12345, 0);
    const b = botSeed(12345, 1);
    const c = botSeed(12345, 2);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it('outputs a uint32', () => {
    for (const slot of [0, 1, 2, 7]) {
      const v = botSeed(987654321, slot);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBe(v >>> 0);
    }
  });
});

describe('botRandFloat', () => {
  it('is deterministic and in [0, 1)', () => {
    const [a] = botRandFloat(42);
    const [b] = botRandFloat(42);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it('reproduces the same sequence when threaded', () => {
    const draw = (seed: number, n: number): number[] => {
      const out: number[] = [];
      let state = seed;
      for (let i = 0; i < n; i += 1) {
        const [v, next] = botRandFloat(state);
        out.push(v);
        state = next;
      }
      return out;
    };
    expect(draw(7, 8)).toEqual(draw(7, 8));
  });
});
