import { describe, expect, it } from 'vitest';

import { nextDDA, type DdaState } from '../../../client/src/net/dda';

const S = (tier: DdaState['tier'], streak: number): DdaState => ({ tier, streak });

describe('nextDDA — local dynamic difficulty', () => {
  it('two wins in a row bump the tier up and reset the streak', () => {
    let s = S('normal', 0);
    s = nextDDA(s, 'win');
    expect(s).toEqual(S('normal', 1)); // one win — not yet
    s = nextDDA(s, 'win');
    expect(s).toEqual(S('hard', 0)); // second win — up a rung
  });

  it('two losses in a row drop the tier down and reset the streak', () => {
    let s = S('normal', 0);
    s = nextDDA(s, 'loss');
    s = nextDDA(s, 'loss');
    expect(s).toEqual(S('easy', 0));
  });

  it('a win cancels a losing streak instead of compounding', () => {
    let s = S('normal', -1);
    s = nextDDA(s, 'win');
    expect(s).toEqual(S('normal', 1)); // flipped to a fresh +1, no tier change
  });

  it('clamps at the top and bottom rungs', () => {
    expect(nextDDA(S('hard', 1), 'win')).toEqual(S('hard', 2)); // can't go above hard
    expect(nextDDA(S('easy', -1), 'loss')).toEqual(S('easy', -2)); // can't go below easy
  });

  it('draws never change the state', () => {
    const s = S('normal', 1);
    expect(nextDDA(s, 'draw')).toBe(s);
  });
});
