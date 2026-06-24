/**
 * Regression guard for the 亂V/ChaosV bot archetype's self-preservation.
 *
 * ChaosV is deliberately AGGRESSIVE: instead of single-bomb-and-retreat it lays
 * a short V/zigzag chain of bombs (paced one per detonation) to wall off a
 * fleeing foe. The danger is that a bot that bombs again-and-again could blow
 * ITSELF up. This test pins the self-trap rate low so the chain stays safe.
 *
 * Crucially, every chain bomb still passes the SAME full escape validation a
 * single bomb does (escHit !== null, dist in [1, maxEscapeLen], escape fits in
 * the fuse) and is gated by `activeBombs < cannon`; the chain only changes
 * PRIORITY, never the safety gate. With cannon starting at 1, the bot can only
 * lay the next chain bomb AFTER the previous one has detonated and it is safe
 * again — that timing offset is what prevents self-bombing.
 *
 * Measurement (own-bomb trap attribution by re-deriving blast coverage per
 * tick) mirrors src/selfkill.ts — replicated here because selfkill.ts keys off
 * Difficulty presets and cannot take ChaosV's custom tuning. Fully
 * deterministic: BotController carries its own RNG; the sim is pure.
 *
 * This guard runs the LIVE bot (v5 BotController + the live archetype tuning
 * from STRATEGIES — see LIVE_STRATEGY below), pinning the live archetype's
 * V-chain self-trap rate low: it is a regression guard against the current live
 * decision logic, not a frozen baseline. (The v2 'chaosv' archetype this test
 * was born for has since folded into the single v5 Zoner backbone; the V-chain
 * own-bomb attribution still exercises the live bomb/escape cycle.)
 */
import { describe, expect, it } from 'vitest';

import { yieldToEventLoop } from '../src/async-yield';

import { FUSE_TICKS, SPARK_TICKS } from '../../../shared/constants';
import { TileKind } from '../../../shared/types';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { type InputFrame } from '../../../client/src/sim/InputBuffer';
import { idx, inBounds } from '../../../client/src/sim/Map';
import { tileOf } from '../../../client/src/sim/Player';
import { createInitialState, tick, type SimState } from '../../../client/src/sim/Sim';
import { BotController } from '../../../client/src/ai/v5/BotController';
import { botSeed } from '../../../client/src/ai/v5/BotConfig';
import { STRATEGIES } from '../../../client/src/ai/v5/Strategies';

// v2 had a dedicated 'chaosv' V-chain archetype; the live v5 backbone collapsed
// to a single Zoner strategy (chaosv's descendant lineage went v3:trapper →
// folded away). With no 'chaosv' key on the live roster, this guard now pins the
// self-trap safety of the LIVE archetype (STRATEGIES[0]) driven through the same
// V-chain-aware own-bomb attribution below.
const LIVE_STRATEGY = STRATEGIES.find((s) => s.key === 'chaosv') ?? STRATEGIES[0]!;

const SEED_START = 1;
const SEED_COUNT = 80;
const NUM_BOTS = 4;
const WINDOW_TICKS = FUSE_TICKS * 10;

// MEASURED ChaosV botsSelfTrappedRate over 80 seeds = 0.053125 (17/320).
// THRESHOLD = measured + ~0.05 headroom = ~0.103, clamped into the [0.15, 0.20]
// band → 0.15. Generous so the guard never goes flaky while still catching a
// real regression in the chain's self-safety.
const THRESHOLD = 0.15;

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
    if (b.fuseTicks > 1) continue; // only bombs melting on this tick.
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
 * Run one all-ChaosV 2-team match for a fixed window and return the number of
 * distinct bots that trapped THEMSELVES (own-bomb) at least once. Teams
 * alternate (0,1,0,1) so the match stays alive long enough to exercise chains.
 */
function runSelfTrapMatch(
  seed: number,
  numBots: number,
  windowTicks: number,
): number {
  const fp = makeFeelParams();
  const teams = Array.from({ length: numBots }, (_, i) => i % 2); // 0,1,0,1…
  let state: SimState = createInitialState(seed, fp, numBots, { teams });
  const controllers = state.players.map(
    (p) => new BotController(botSeed(seed, p.slot), LIVE_STRATEGY.tuning, p.slot),
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

/** botsSelfTrapped / (numBots * seedCount) over a contiguous seed block. */
async function measure(seedStart: number, seedCount: number): Promise<number> {
  let botsSelfTrapped = 0;
  for (let i = 0; i < seedCount; i++) {
    botsSelfTrapped += runSelfTrapMatch(seedStart + i, NUM_BOTS, WINDOW_TICKS);
    await yieldToEventLoop(); // between independent matches; result-neutral
  }
  return botsSelfTrapped / (NUM_BOTS * seedCount);
}

describe('ChaosV self-trap rate stays low (regression guard)', () => {
  it(`< ${(THRESHOLD * 100).toFixed(0)}% of ChaosV bots self-trap`, async () => {
    const rate = await measure(SEED_START, SEED_COUNT);
    expect(rate).toBeLessThan(THRESHOLD);
  });

  it('the measurement is deterministic (same seeds → identical rate)', async () => {
    const a = await measure(SEED_START, 20);
    const b = await measure(SEED_START, 20);
    expect(a).toEqual(b);
  });
});
