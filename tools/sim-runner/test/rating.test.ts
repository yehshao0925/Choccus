import { describe, expect, it } from 'vitest';

import {
  defaultRating,
  displayScore,
  rateOutcome,
  type RatedPlayer,
} from '../../../client/src/rating/Rating';

const player = (id: string, team: number): RatedPlayer => ({
  id,
  team,
  rating: defaultRating(),
});

describe('Rating (OpenSkill wrapper)', () => {
  it('default rating is μ=25, σ≈8.333 and displays as ~0', () => {
    const r = defaultRating();
    expect(r.mu).toBeCloseTo(25);
    expect(r.sigma).toBeCloseTo(25 / 3);
    expect(displayScore(r)).toBeCloseTo(0);
  });

  it('1v1: winner gains, loser loses', () => {
    const next = rateOutcome([player('a', 0), player('b', 1)], 0);
    expect(displayScore(next.get('a')!)).toBeGreaterThan(0);
    expect(displayScore(next.get('b')!)).toBeLessThan(0);
  });

  it('2v2: both winners gain, both losers lose', () => {
    const players = [
      player('a', 0),
      player('b', 0),
      player('c', 1),
      player('d', 1),
    ];
    const next = rateOutcome(players, 1); // team 1 wins
    expect(displayScore(next.get('c')!)).toBeGreaterThan(0);
    expect(displayScore(next.get('d')!)).toBeGreaterThan(0);
    expect(displayScore(next.get('a')!)).toBeLessThan(0);
    expect(displayScore(next.get('b')!)).toBeLessThan(0);
  });

  it('draw (winnerTeam null) barely moves equal-rated players', () => {
    const next = rateOutcome([player('a', 0), player('b', 1)], null);
    // A symmetric draw between identical ratings ⇒ mu unchanged, sigma shrinks.
    expect(next.get('a')!.mu).toBeCloseTo(25, 5);
    expect(next.get('a')!.sigma).toBeLessThan(25 / 3);
  });

  it('bots are just players: a bot id updates like any other', () => {
    const next = rateOutcome([player('human', 0), player('CocoaBot', 1)], 0);
    expect(displayScore(next.get('CocoaBot')!)).toBeLessThan(0); // bot lost
    expect(next.has('human')).toBe(true);
  });

  it('fewer than two teams is a no-op', () => {
    const next = rateOutcome([player('a', 0), player('b', 0)], 0);
    expect(next.get('a')).toEqual(defaultRating());
  });
});
