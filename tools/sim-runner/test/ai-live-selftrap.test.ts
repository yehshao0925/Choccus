/**
 * Self-preservation guard for the NEW LIVE BotController (single weighted
 * scoring loop). Distinct from ai-selfkill.test.ts in two ways:
 *   1. ai-selfkill measures the three Difficulty PRESETS via measureSelfTrapRate;
 *      here we ALSO drive every live STRATEGIES archetype directly with the
 *      live v5 BotController (replicating the runSelfTrapMatch loop, since
 *      measureSelfTrapRate keys off Difficulty and cannot take a strategy
 *      tuning), and assert a per-preset ceiling. (v2 shipped four archetypes;
 *      the live v5 backbone has collapsed to a single Zoner strategy — this
 *      iterates whatever STRATEGIES the live version defines.)
 *   2. We assert a TIGHT AGGREGATE — the average botsSelfTrappedRate across all
 *      three difficulties — well below where the old hierarchical bot sat,
 *      pinning the scoring loop's emergent self-safety.
 *
 * Own-bomb trap attribution mirrors src/selfkill.ts (stampDetonations +
 * ageStamps + alive→trapped edge with owner === slot). Fully deterministic: the
 * bot carries its own RNG; the sim is pure.
 */
import { describe, expect, it } from 'vitest';

import { FUSE_TICKS, SPARK_TICKS } from '../../../shared/constants';
import { TileKind } from '../../../shared/types';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { type InputFrame } from '../../../client/src/sim/InputBuffer';
import { idx, inBounds } from '../../../client/src/sim/Map';
import { tileOf } from '../../../client/src/sim/Player';
import { createInitialState, tick, type SimState } from '../../../client/src/sim/Sim';
import { BotController } from '../../../client/src/ai/v5/BotController';
import {
  type BotTuning,
  botSeed,
  tuningFor,
  type Difficulty,
} from '../../../client/src/ai/v5/BotConfig';
import { STRATEGIES } from '../../../client/src/ai/v5/Strategies';
import { measureSelfTrapRate } from '../src/selfkill';
import { yieldToEventLoop } from '../src/async-yield';

const SEED_START = 1;
const SEED_COUNT = 40;
const NUM_BOTS = 4;
const WINDOW_TICKS = FUSE_TICKS * 10;

/**
 * Tight aggregate ceiling: average of botsSelfTrappedRate over easy+normal+hard.
 * Measured ≈ 0.005 with the scoring loop; 0.05 leaves ample headroom while
 * still catching a real self-safety regression.
 */
const AGG_CEILING = 0.05;

/** Per-strategy self-trap ceiling (measured ≈ 0.00–0.03 across presets). */
const STRATEGY_CEILING = 0.06;

const ARM_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

/** Stamp tiles a bomb detonating THIS tick will cover with its owner slot. */
function stampDetonations(
  state: SimState,
  recent: Map<number, { owner: number; ttl: number }>,
): void {
  for (const b of state.bombs) {
    if (b.fuseTicks > 1) continue;
    const stamp = (i: number): void => {
      recent.set(i, { owner: b.ownerSlot, ttl: SPARK_TICKS + 2 });
    };
    stamp(idx(b.tileX, b.tileY));
    for (const [dx, dy] of ARM_DELTAS) {
      for (let step = 1; step <= b.fire; step++) {
        const tx = b.tileX + dx * step;
        const ty = b.tileY + dy * step;
        if (!inBounds(tx, ty)) break;
        const t = state.map[idx(tx, ty)];
        if (t === TileKind.HARD) break;
        if (t === TileKind.SOFT) break; // soft cleared with no flame cell.
        stamp(idx(tx, ty));
      }
    }
  }
}

/** Age the recent-owner stamps by one tick, dropping expired entries. */
function ageStamps(recent: Map<number, { owner: number; ttl: number }>): void {
  for (const [tile, v] of recent) {
    v.ttl -= 1;
    if (v.ttl <= 0) recent.delete(tile);
  }
}

/**
 * Run one all-LIVE-bot 2-team match for a fixed window with a given tuning and
 * return how many distinct bots trapped THEMSELVES (own-bomb) at least once.
 * Teams alternate (0,1,0,1) so the match stays alive long enough to exercise
 * the scoring loop's bomb/escape cycle.
 */
function runLiveSelfTrapMatch(
  seed: number,
  tuning: BotTuning,
  windowTicks: number,
): number {
  const fp = makeFeelParams();
  const teams = Array.from({ length: NUM_BOTS }, (_, i) => i % 2);
  let state: SimState = createInitialState(seed, fp, NUM_BOTS, { teams });
  const controllers = state.players.map(
    (p) => new BotController(botSeed(seed, p.slot), tuning, p.slot),
  );

  const wasTrapped = state.players.map(() => false);
  const selfTrappedEver = state.players.map(() => false);
  const recent = new Map<number, { owner: number; ttl: number }>();

  for (let t = 0; t < windowTicks; t++) {
    stampDetonations(state, recent);
    const inputs: InputFrame[] = state.players.map((p) =>
      controllers[p.slot]!.sample(state, p.slot),
    );
    const next = tick(state, inputs);

    for (const p of next.players) {
      const s = p.slot;
      if (p.trapped && !wasTrapped[s]) {
        const owner = recent.get(idx(tileOf(p.posX), tileOf(p.posY)))?.owner;
        if (owner === s) selfTrappedEver[s] = true;
      }
      wasTrapped[s] = p.trapped;
    }

    ageStamps(recent);
    state = next;
    if (state.phase !== 1 /* PLAYING */) break;
  }

  return selfTrappedEver.filter(Boolean).length;
}

/** botsSelfTrapped / (NUM_BOTS * seedCount) for a strategy tuning. */
async function measureStrategy(
  tuning: BotTuning,
  seedStart: number,
  seedCount: number,
): Promise<number> {
  let bots = 0;
  for (let i = 0; i < seedCount; i++) {
    bots += runLiveSelfTrapMatch(seedStart + i, tuning, WINDOW_TICKS);
    await yieldToEventLoop(); // between independent matches; result-neutral
  }
  return bots / (NUM_BOTS * seedCount);
}

describe('Live BotController (scoring loop) self-trap rate stays low', () => {
  it(`aggregate over easy+normal+hard < ${(AGG_CEILING * 100).toFixed(0)}%`, async () => {
    const rates: Record<Difficulty, number> = { easy: 0, normal: 0, hard: 0 };
    for (const d of ['easy', 'normal', 'hard'] as const) {
      rates[d] = (await measureSelfTrapRate(d, SEED_START, SEED_COUNT)).botsSelfTrappedRate;
    }
    const agg = (rates.easy + rates.normal + rates.hard) / 3;
    // Reported for the build log.
    console.log(
      `[live self-trap] easy=${rates.easy.toFixed(4)} normal=${rates.normal.toFixed(
        4,
      )} hard=${rates.hard.toFixed(4)} agg=${agg.toFixed(4)}`,
    );
    expect(agg).toBeLessThan(AGG_CEILING);
  });

  it(`each of the ${STRATEGIES.length} STRATEGIES keeps < ${(STRATEGY_CEILING * 100).toFixed(0)}% self-trap`, async () => {
    for (const s of STRATEGIES) {
      const rate = await measureStrategy(s.tuning, SEED_START, SEED_COUNT);
      console.log(`[live self-trap] strategy ${s.key} = ${rate.toFixed(4)}`);
      expect(rate, `${s.key} self-trap rate`).toBeLessThanOrEqual(STRATEGY_CEILING);
    }
  });

  it('the measurement is deterministic (same seeds → identical)', async () => {
    const tuning = tuningFor('hard');
    const a = await measureStrategy(tuning, SEED_START, 15);
    const b = await measureStrategy(tuning, SEED_START, 15);
    expect(a).toEqual(b);
  });
});
