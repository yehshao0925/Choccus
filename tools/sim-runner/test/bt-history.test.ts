import { describe, it, expect } from 'vitest';
import {
  emptyHistory,
  upsertPair,
  agentIds,
  toTally,
  parseAgentId,
  formatAgentId,
  parseHistory,
  serializeHistory,
} from '../src/bt-history';

describe('agent id parsing', () => {
  it('round-trips version:archetype', () => {
    expect(parseAgentId('v3:hunter')).toEqual({ version: 3, archetype: 'hunter' });
    expect(formatAgentId(3, 'Hunter')).toBe('v3:hunter');
  });
  it('rejects malformed ids', () => {
    expect(() => parseAgentId('hunter')).toThrow();
    expect(() => parseAgentId('3:hunter')).toThrow();
  });
});

describe('upsertPair', () => {
  it('canonicalises pair order (either seating writes one record)', () => {
    const h = emptyHistory('classic');
    upsertPair(h, 'v3:hunter', 'v3:farmer', 60, 40, 0);
    expect(h.pairs.length).toBe(1);
    // farmer < hunter lexicographically, so a=farmer with its wins (40).
    expect(h.pairs[0]!.a).toBe('v3:farmer');
    expect(h.pairs[0]!.winsA).toBe(40);
    expect(h.pairs[0]!.winsB).toBe(60);
  });

  it('REPLACES on re-run instead of double-counting', () => {
    const h = emptyHistory('classic');
    upsertPair(h, 'v3:hunter', 'v3:farmer', 60, 40, 0);
    upsertPair(h, 'v3:hunter', 'v3:farmer', 70, 30, 0); // re-run, more repeats
    expect(h.pairs.length).toBe(1);
    expect(h.pairs[0]!.winsB).toBe(70); // hunter is b; latest result wins
  });

  it('records games and draws', () => {
    const h = emptyHistory('classic');
    upsertPair(h, 'v3:a', 'v3:b', 45, 45, 10);
    expect(h.pairs[0]!.games).toBe(90);
    expect(h.pairs[0]!.draws).toBe(10);
  });

  it('refuses a self-pairing', () => {
    const h = emptyHistory('classic');
    expect(() => upsertPair(h, 'v3:a', 'v3:a', 1, 1, 0)).toThrow();
  });
});

describe('toTally', () => {
  it('builds win/games matrices indexed by the given id order', () => {
    const h = emptyHistory('classic');
    upsertPair(h, 'v3:a', 'v3:b', 30, 20, 0); // a beats b 30-20
    upsertPair(h, 'v3:b', 'v3:c', 25, 25, 0);
    const ids = ['v3:a', 'v3:b', 'v3:c'];
    const { wins, games } = toTally(h, ids);
    expect(wins[0]![1]).toBe(30); // a vs b
    expect(wins[1]![0]).toBe(20);
    expect(games[0]![1]).toBe(50);
    expect(games[0]![2]).toBe(0); // a never met c
    expect(games[1]![2]).toBe(50);
  });

  it('skips pairs referencing ids outside the requested set', () => {
    const h = emptyHistory('classic');
    upsertPair(h, 'v3:a', 'v4:x', 10, 10, 0);
    const { games } = toTally(h, ['v3:a']); // v4:x excluded
    expect(games[0]![0]).toBe(0);
  });
});

describe('agentIds', () => {
  it('returns sorted distinct ids', () => {
    const h = emptyHistory('classic');
    upsertPair(h, 'v3:hunter', 'v3:farmer', 1, 1, 0);
    upsertPair(h, 'v4:x', 'v3:hunter', 1, 1, 0);
    expect(agentIds(h)).toEqual(['v3:farmer', 'v3:hunter', 'v4:x']);
  });
});

describe('serialize / parse', () => {
  it('round-trips and sorts pairs deterministically', () => {
    const h = emptyHistory('classic');
    upsertPair(h, 'v3:zoner', 'v3:hunter', 1, 1, 0);
    upsertPair(h, 'v3:farmer', 'v3:hunter', 1, 1, 0);
    const text = serializeHistory(h);
    const back = parseHistory(text);
    expect(back.map).toBe('classic');
    // Re-serialising the parsed copy is byte-identical (stable order).
    expect(serializeHistory(back)).toBe(text);
  });
});
