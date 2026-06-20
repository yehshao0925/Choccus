/**
 * Shared sim-orchestration skeleton for the cross-version benches.
 *
 * Extracted (moved, not rewritten) from cross-version-bench.ts so the matrix
 * bench (matrix-bench.ts) and any future bench reuse the exact same match-
 * running discipline. The two match entry points are `runMatchSeeded` (run one
 * FFA match under an EXPLICIT seed — what the CRN matrix bench needs so every
 * pairing replays the same "luck") and `runMatch` (the legacy convenience that
 * derives `seed = BASE + globalMatchIndex` for counter-style schedules).
 *
 * Determinism discipline (do NOT break): no Date / Math.random / performance.
 * Every per-match seed is either passed in explicitly or derived from a running
 * GLOBAL match counter, so repeated runs are bit-identical.
 */
import { GamePhase } from '../../../shared/types';
import {
  MATCH_MAX_TICKS,
  PLAYER_START_CANNON,
  PLAYER_START_FIRE,
  PLAYER_START_SPEED_BONUS,
} from '../../../shared/constants';
import {
  AI_VERSIONS,
  type BotSpec,
  type IBotController,
} from '../../../client/src/ai/index';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { type InputFrame } from '../../../client/src/sim/InputBuffer';
import { type PlayerState } from '../../../client/src/sim/Player';
import {
  tick,
  createInitialState,
  type SimState,
} from '../../../client/src/sim/Sim';

/** FFA player count = the fixed number of spawn corners. */
export const N = 4;
/** Per-match tick cap (3 min @ 60 Hz); the sim itself also forces OVER here. */
export const MAX_TICKS = MATCH_MAX_TICKS;
/** Base match seed; per-match seed = (BASE + globalMatchIndex) >>> 0. */
export const BASE = 0x12345678;
/** Difficulty is ignored when a strategy archetype is set; kept for the spec. */
export const DIFFICULTY = 'normal';

/** Map layouts the benches evaluate, each printed as its own breakdown. */
export type MapKind = 'classic' | 'pirate';
export const MAPS: readonly MapKind[] = ['classic', 'pirate'];

/** The four archetype keys, same as duel-bench / tournament, in FIXED order. */
export const ARCHETYPE_KEYS: readonly string[] = [
  'aggressor',
  'turtle',
  'gambler',
  'chaosv',
];

/** Capitalize an archetype key for display ('aggressor' -> 'Aggressor'). */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** Right-pad a cell to width. */
export function padR(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/** Left-pad a cell to width. */
export function padL(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

/**
 * All permutations of [0..n-1] in lexicographic order (deterministic, no RNG).
 * Used to rotate which agent sits in which slot/corner across matches.
 */
export function lexPermutations(n: number): number[][] {
  const base = Array.from({ length: n }, (_, i) => i);
  const out: number[][] = [];
  const recurse = (prefix: number[], rest: number[]): void => {
    if (rest.length === 0) {
      out.push(prefix);
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      recurse([...prefix, rest[i]!], [...rest.slice(0, i), ...rest.slice(i + 1)]);
    }
  };
  recurse([], base);
  return out;
}

/**
 * All `choose`-sized combinations of `arr` in lexicographic order
 * (deterministic, no RNG). Used to enumerate which agents share a table.
 */
export function combinations(arr: number[], choose: number): number[][] {
  const out: number[][] = [];
  const recurse = (start: number, prefix: number[]): void => {
    if (prefix.length === choose) {
      out.push(prefix.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      prefix.push(arr[i]!);
      recurse(i + 1, prefix);
      prefix.pop();
    }
  };
  recurse(0, []);
  return out;
}

/**
 * The "cyclic rotations" set that fills n seats with n agents (NOT n!).
 * Rotation i maps agent->slot as agentIdxs[(slot - i + n) % n], so every agent
 * lands in every slot exactly once across the n rotations (cancels spawn-point
 * bias) without paying the full-factorial cost.
 * Returns n arrays of length n: rot[i][slot] = agentIndex.
 */
export function cyclicRotations(agentIdxs: number[]): number[][] {
  const n = agentIdxs.length;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const rot: number[] = new Array(n);
    for (let slot = 0; slot < n; slot++) {
      rot[slot] = agentIdxs[(slot - i + n) % n]!;
    }
    out.push(rot);
  }
  return out;
}

/**
 * Item-progress score = number of pickups collected (fire + cannon + speed).
 * Each fire/cannon item is +1 to its stat; each speed item is +4 tenths, so
 * dividing the speed bonus by 4 recovers the speed-item count. Pure integer.
 */
export function itemScore(p: PlayerState): number {
  return (
    (p.fire - PLAYER_START_FIRE) +
    (p.cannon - PLAYER_START_CANNON) +
    Math.trunc((p.speedBonusTenths - PLAYER_START_SPEED_BONUS) / 4)
  );
}

/**
 * Pick the tiebreak winner among the given alive slots by item score, then
 * fire, then cannon (all desc). Returns the slot, or null if the top two are
 * exactly tied on every key (a genuine draw). Deterministic: no RNG, and the
 * comparison keys plus stable slot order fully determine the result.
 */
export function tiebreakWinner(state: SimState, aliveSlots: number[]): number | null {
  const key = (s: number): [number, number, number] => {
    const p = state.players[s]!;
    return [itemScore(p), p.fire, p.cannon];
  };
  const sorted = aliveSlots
    .slice()
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i]! !== kb[i]!) return kb[i]! - ka[i]!;
      }
      return a - b; // stable, but only reached on a full tie
    });
  const top = sorted[0]!;
  const second = sorted[1]!;
  const kt = key(top);
  const ks = key(second);
  const fullTie = kt.every((v, i) => v === ks[i]!);
  return fullTie ? null : top;
}

/**
 * An agent: an AI version paired with an archetype key, plus a clear label like
 * "v2-Aggressor" used in every table. Ratings aggregate per agent identity (its
 * index in the agents array).
 */
export interface Agent {
  version: number;
  archetypeKey: string;
  label: string;
}

/** Build an agent with an auto-derived "v<V>-<Archetype>" label. */
export function makeAgent(version: number, archetypeKey: string): Agent {
  return {
    version,
    archetypeKey,
    label: `v${version}-${capitalize(archetypeKey)}`,
  };
}

/** Build a controller for a slot from an AI version and archetype key. */
export function makeController(
  version: number,
  archetypeKey: string,
  seed: number,
  slot: number,
): IBotController {
  const spec: BotSpec = { difficulty: DIFFICULTY, strategyRaw: archetypeKey };
  return AI_VERSIONS[version]!.createBot(seed, slot, spec);
}

/** One FFA match's per-slot survival + winner info. */
export interface MatchRecord {
  /** Elimination tick per slot (end tick if the slot survived). Length N. */
  elimTick: number[];
  /** Agent index occupying each slot this match. */
  slotAgent: number[];
  /** Agent index of the sole/tiebreak winner, or null for a draw. */
  winnerAgent: number | null;
  draw: boolean;
  /** True when the winner was decided by the tick-cap item tiebreak. */
  tiebreak: boolean;
  /** True when the match hit the tick cap with >1 survivor (dragged to timeout,
   *  as opposed to a clean kill or a same-tick mutual KO). Lets the head-to-head
   *  benches judge "challenger dragged to the cap → loses" (see v3-bench). */
  timedOut: boolean;
}

/**
 * Run one FFA match under an EXPLICIT seed and return per-slot survival +
 * winner info. `slotAgent[s]` is the agent index occupying slot/corner s this
 * match; `agents` maps that index to an `Agent`.
 *
 * This is the entry point the CRN matrix bench uses: it passes the SAME seed to
 * every pairing of a given (map, repeat) so the map layout and each slot's bot
 * RNG seeding are identical across pairings — only the occupying agents change,
 * isolating pure skill. Fully deterministic: same (seed, slotAgent, agents,
 * map, n) ⇒ same MatchRecord, every time and in any thread.
 */
export function runMatchSeeded(
  seed: number,
  slotAgent: number[],
  agents: Agent[],
  mapKind: MapKind,
  n: number = N,
  // Per-match tick cap. Defaults to the real 3-min cap; only the determinism
  // tests pass a shorter value to keep the bit-identity check fast (determinism
  // holds at any length). The sim itself also forces OVER at MATCH_MAX_TICKS.
  maxTicks: number = MAX_TICKS,
  makeCtrl: (agent: Agent, seed: number, slot: number) => IBotController = (
    a,
    s,
    slot,
  ) => makeController(a.version, a.archetypeKey, s, slot),
): MatchRecord {
  const teams = Array.from({ length: n }, (_, i) => i);
  let state: SimState = createInitialState(seed, makeFeelParams(), n, {
    pvp: true,
    teams,
    map: mapKind,
  });

  const controllers: IBotController[] = [];
  for (let s = 0; s < n; s++) {
    const a = agents[slotAgent[s]!]!;
    controllers.push(makeCtrl(a, seed, s));
  }

  const elimTick: number[] = new Array(n).fill(-1);

  while (state.phase === GamePhase.PLAYING && state.tick < maxTicks) {
    const frame: InputFrame[] = [];
    for (let s = 0; s < n; s++) frame.push(controllers[s]!.sample(state, s));
    state = tick(state, frame);
    // Record first tick at which a slot's player is no longer alive
    // (trapped does NOT count — only !alive is elimination).
    for (let s = 0; s < n; s++) {
      if (elimTick[s] === -1 && !state.players[s]!.alive) elimTick[s] = state.tick;
    }
  }

  const endTick = state.tick;
  for (let s = 0; s < n; s++) if (elimTick[s] === -1) elimTick[s] = endTick;

  const aliveSlots: number[] = [];
  for (let s = 0; s < n; s++) if (state.players[s]!.alive) aliveSlots.push(s);

  // >1 survivor at the end ⇒ the match was dragged to the tick cap (a clean
  // finish leaves 1, a mutual KO leaves 0). This is the "timeout" signal.
  const timedOut = aliveSlots.length > 1;

  let winnerAgent: number | null = null;
  let draw = true;
  let tiebreak = false;
  if (state.phase === GamePhase.OVER && aliveSlots.length === 1) {
    // Clean last-bot-standing finish.
    winnerAgent = slotAgent[aliveSlots[0]!]!;
    draw = false;
  } else if (aliveSlots.length > 1) {
    // Hit the tick cap with multiple survivors: break the tie on item progress.
    const winSlot = tiebreakWinner(state, aliveSlots);
    if (winSlot !== null) {
      winnerAgent = slotAgent[winSlot]!;
      draw = false;
      tiebreak = true;
    }
  }

  return {
    elimTick,
    slotAgent: slotAgent.slice(),
    winnerAgent,
    draw,
    tiebreak,
    timedOut,
  };
}

/**
 * Convenience wrapper for counter-style schedules: derive the per-match seed
 * from a running GLOBAL match counter (`seed = (BASE + globalMatchIndex) >>> 0`)
 * and delegate to `runMatchSeeded`. CRN benches that must REUSE a seed across
 * pairings should call `runMatchSeeded` directly instead.
 */
export function runMatch(
  globalMatchIndex: number,
  slotAgent: number[],
  agents: Agent[],
  mapKind: MapKind,
  n: number = N,
): MatchRecord {
  const seed = (BASE + globalMatchIndex) >>> 0;
  return runMatchSeeded(seed, slotAgent, agents, mapKind, n);
}

/**
 * Derive per-slot rank (1 = died first ... N = survived longest), HUMAN-READABLE
 * ONLY. Ties on elimTick are broken by slot index (then agent index) so this is
 * a total order — but that slot-index tiebreak injects spawn-corner artifacts,
 * so win-rate ratings must NOT use it.
 */
export function computeRanksBySlot(result: MatchRecord, n: number = N): number[] {
  const order = Array.from({ length: n }, (_, s) => s).sort((a, b) => {
    if (result.elimTick[a]! !== result.elimTick[b]!) {
      return result.elimTick[a]! - result.elimTick[b]!;
    }
    if (a !== b) return a - b;
    return result.slotAgent[a]! - result.slotAgent[b]!;
  });
  const rankBySlot: number[] = new Array(n).fill(0);
  for (let i = 0; i < order.length; i++) rankBySlot[order[i]!] = i + 1;
  return rankBySlot;
}
