/**
 * Self-kill measurement harness for the AI BotController (measurement-only).
 *
 * Runs an all-bot free-for-all and classifies every player's elimination as:
 *  - 'self'  — the explosion that trapped them came from a bomb THEY owned;
 *  - 'foe'   — it came from someone else's bomb;
 *  - 'other' — trapped by no attributable bomb (timeout with no clear owner),
 *              or eliminated without an attributable trap cause.
 *
 * Why this lives outside the sim: explosion cells (ExplosionState) intentionally
 * do NOT carry an owner slot, and we must NOT change sim state structures just to
 * measure. So here — purely in measurement code — we re-derive, per tick, which
 * bomb owner's blast would cover each tile (same cross-arm rules as Explosion.ts)
 * and remember, for each player, the most recent owner whose blast covered the
 * player's tile. When a player transitions alive→trapped we read that attribution;
 * when they later transition trapped→eliminated (alive=false) we bucket the death.
 *
 * Fully deterministic: BotController carries its own RNG (botSeed), the sim is
 * pure, and there is no wall-clock or Math.random here.
 */
import { FUSE_TICKS, SPARK_TICKS } from '../../../shared/constants';
import { TileKind } from '../../../shared/types';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { type InputFrame } from '../../../client/src/sim/InputBuffer';
import { idx, inBounds } from '../../../client/src/sim/Map';
import { tileOf } from '../../../client/src/sim/Player';
import { createInitialState, tick, type SimState } from '../../../client/src/sim/Sim';
// Single-version measurement tool: pinned to the latest live AI version (v5).
import { BotController } from '../../../client/src/ai/v5/BotController';
import { botSeed, tuningFor, type Difficulty } from '../../../client/src/ai/v5/BotConfig';
import { yieldToEventLoop } from './async-yield';

export type DeathCause = 'self' | 'foe' | 'other';

export interface SelfKillStats {
  difficulty: Difficulty;
  seeds: number;
  /** Players eliminated (trapped → shell broke / enemy touch) over all matches. */
  eliminations: number;
  self: number;
  foe: number;
  other: number;
  /** self / max(1, eliminations). */
  selfRate: number;
}

const ARM_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

/**
 * Stamp each tile that a bomb detonating THIS tick (fuse <= 1, pre-tick) will
 * cover with its owner slot, into `recent` with a TTL long enough to outlive
 * the resulting explosion cells (SPARK_TICKS). We must attribute on detonation
 * because, by the time a player is actually trapped, the bomb is already gone
 * from state.bombs (it became explosion cells the same tick) — explosion cells
 * deliberately carry no owner. Cross-arm rules mirror Explosion.ts; the soonest
 * (smallest-fuse) owner wins a contested tile. Measurement-only — never touches
 * sim state.
 */
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
        if (t === TileKind.SOFT) {
          // Soft brick is cleared with NO flame cell — do not stamp it; the arm
          // simply stops here (matches Explosion.ts).
          break;
        }
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

/** Per-match self-trap tally over a fixed window (see runSelfTrapMatch). */
export interface MatchTally {
  /** alive→trapped edges caused by the player's OWN bomb. */
  selfTraps: number;
  /** alive→trapped edges caused by a DIFFERENT bot's bomb. */
  foeTraps: number;
  /** alive→trapped edges with no attributable bomb owner. */
  otherTraps: number;
  /** Distinct bots that self-trapped at least once this match. */
  botsSelfTrapped: number;
  /** Bots in the match. */
  bots: number;
}

/**
 * Run one all-bot 2-team match for a fixed window and tally self-trap EVENTS.
 * Bots are split into two alternating teams (0,1,0,1,…): this keeps the match
 * alive far longer than a separate-team free-for-all (the "last team standing"
 * win check ends a match the instant one side is wiped, and an all-same-team
 * setup would end on tick 1), while still letting foe bombs / rescues happen.
 * Every trap is attributed by bomb OWNER, so only genuine OWN-bomb traps count
 * as self-traps — isolating the bot's tendency to blow ITSELF up.
 */
function runSelfTrapMatch(
  seed: number,
  difficulty: Difficulty,
  numBots: number,
  windowTicks: number,
): MatchTally {
  const fp = makeFeelParams();
  const teams = Array.from({ length: numBots }, (_, i) => i % 2); // 0,1,0,1…
  let state: SimState = createInitialState(seed, fp, numBots, { teams });
  const controllers = state.players.map(
    (p) => new BotController(botSeed(seed, p.slot), tuningFor(difficulty), p.slot),
  );

  const wasTrapped = state.players.map(() => false);
  const selfTrappedEver = state.players.map(() => false);
  const recent = new Map<number, { owner: number; ttl: number }>();
  let selfTraps = 0;
  let foeTraps = 0;
  let otherTraps = 0;

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
        if (owner === undefined) otherTraps += 1;
        else if (owner === s) {
          selfTraps += 1;
          selfTrappedEver[s] = true;
        } else foeTraps += 1;
      }
      wasTrapped[s] = p.trapped;
    }

    ageStamps(recent);
    state = next;
    if (state.phase !== 1 /* PLAYING */) break;
  }

  return {
    selfTraps,
    foeTraps,
    otherTraps,
    botsSelfTrapped: selfTrappedEver.filter(Boolean).length,
    bots: numBots,
  };
}

/** Run one all-bot match; return each eliminated player's death cause. */
function runMatch(
  seed: number,
  difficulty: Difficulty,
  numBots: number,
  maxTicks: number,
): DeathCause[] {
  const fp = makeFeelParams();
  let state: SimState = createInitialState(seed, fp, numBots);
  const controllers = state.players.map(
    (p) => new BotController(botSeed(seed, p.slot), tuningFor(difficulty), p.slot),
  );

  // Per-slot: was alive last tick, was trapped last tick, and the owner slot we
  // attributed at the moment the player most recently became trapped.
  const wasAlive = state.players.map(() => true);
  const wasTrapped = state.players.map(() => false);
  const trapOwner: Array<number | undefined> = state.players.map(() => undefined);
  const causes: DeathCause[] = [];
  // tile → { owner, ttl }: who caused the flames currently on this tile.
  const recent = new Map<number, { owner: number; ttl: number }>();

  for (let t = 0; t < maxTicks; t++) {
    // Stamp tiles whose bombs detonate this tick BEFORE advancing, so the
    // attribution is live when the resulting trap is detected below.
    stampDetonations(state, recent);

    const inputs: InputFrame[] = state.players.map((p) =>
      controllers[p.slot]!.sample(state, p.slot),
    );
    const next = tick(state, inputs);

    for (const p of next.players) {
      const s = p.slot;
      // alive→trapped edge: read who owns the flames on this player's tile.
      if (p.trapped && !wasTrapped[s]) {
        const tile = idx(tileOf(p.posX), tileOf(p.posY));
        trapOwner[s] = recent.get(tile)?.owner;
      }
      // alive→dead edge: classify the elimination.
      if (wasAlive[s] && !p.alive) {
        const owner = trapOwner[s];
        const cause: DeathCause =
          owner === undefined ? 'other' : owner === s ? 'self' : 'foe';
        causes.push(cause);
      }
      wasAlive[s] = p.alive;
      wasTrapped[s] = p.trapped;
    }

    ageStamps(recent);
    state = next;
    if (state.phase !== 1 /* PLAYING */) break;
  }
  return causes;
}

/** Aggregate self-kill stats over a contiguous block of seeds. */
export function measureSelfKill(
  difficulty: Difficulty,
  seedStart: number,
  seedCount: number,
  numBots = 4,
  maxTicks = FUSE_TICKS * 8,
): SelfKillStats {
  let self = 0;
  let foe = 0;
  let other = 0;
  for (let i = 0; i < seedCount; i++) {
    const causes = runMatch(seedStart + i, difficulty, numBots, maxTicks);
    for (const c of causes) {
      if (c === 'self') self += 1;
      else if (c === 'foe') foe += 1;
      else other += 1;
    }
  }
  const eliminations = self + foe + other;
  return {
    difficulty,
    seeds: seedCount,
    eliminations,
    self,
    foe,
    other,
    selfRate: self / Math.max(1, eliminations),
  };
}

/** Aggregated self-trap propensity over a block of co-op seeds. */
export interface SelfTrapStats {
  difficulty: Difficulty;
  seeds: number;
  bots: number;
  /** Total alive→trapped edges caused by the bot's own bomb. */
  selfTraps: number;
  foeTraps: number;
  otherTraps: number;
  /** Bots that self-trapped >= once / total bot-matches (the headline rate). */
  botsSelfTrappedRate: number;
  /** Self-traps per 1000 bot-ticks (intensity, window-length independent). */
  selfTrapsPerKiloBotTick: number;
}

/**
 * Headline self-trap measurement: many co-op seeds × difficulty. The primary
 * number is `botsSelfTrappedRate` — the fraction of bots that blew THEMSELVES
 * up at least once during the window. In solo mode a self-trap with no teammate
 * is a death, so this is the rate the player perceives as "the bot suicided".
 */
export async function measureSelfTrapRate(
  difficulty: Difficulty,
  seedStart: number,
  seedCount: number,
  numBots = 4,
  windowTicks = FUSE_TICKS * 10,
): Promise<SelfTrapStats> {
  let selfTraps = 0;
  let foeTraps = 0;
  let otherTraps = 0;
  let botsSelfTrapped = 0;
  for (let i = 0; i < seedCount; i++) {
    const m = runSelfTrapMatch(seedStart + i, difficulty, numBots, windowTicks);
    selfTraps += m.selfTraps;
    foeTraps += m.foeTraps;
    otherTraps += m.otherTraps;
    botsSelfTrapped += m.botsSelfTrapped;
    await yieldToEventLoop(); // between independent matches; result-neutral
  }
  const botMatches = numBots * seedCount;
  const botTicks = botMatches * windowTicks;
  return {
    difficulty,
    seeds: seedCount,
    bots: numBots,
    selfTraps,
    foeTraps,
    otherTraps,
    botsSelfTrappedRate: botsSelfTrapped / Math.max(1, botMatches),
    selfTrapsPerKiloBotTick: (selfTraps * 1000) / Math.max(1, botTicks),
  };
}
