/**
 * Diagnostic probe (throwaway): WHY does v2 collapse on the classic map?
 *
 * Runs a 1v1 on classic for a chosen pairing across the matrix-bench CRN seeds
 * and prints, per slot, the development trajectory: bomb attempts, soft bricks
 * broken, final fire/cannon/speed, elimination tick, winner. This separates the
 * candidate causes — under-development (won't farm), passivity (won't bomb), or
 * dies-early-anyway — that the win-rate matrix alone cannot.
 *
 * Usage: tsx src/probe-classic.ts [aKey] [bKey] [map]
 *   defaults: aggressor (v2) vs gambler (v1) on classic.
 */
import { GamePhase, ActionFlags } from '../../../shared/types';
import {
  PLAYER_START_CANNON,
  PLAYER_START_FIRE,
  PLAYER_START_SPEED_BONUS,
} from '../../../shared/constants';
import { AI_VERSIONS, type BotSpec, type IBotController } from '../../../client/src/ai/index';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { type InputFrame } from '../../../client/src/sim/InputBuffer';
import { tick, createInitialState, type SimState } from '../../../client/src/sim/Sim';

const BASE = 0x12345678;
const MAX_TICKS = 10800; // 3 min @ 60 Hz (= shared MATCH_MAX_TICKS)
type MapKind = 'classic' | 'pirate';

// slot 0 = agent A (default v2-aggressor), slot 1 = agent B (default v1-gambler).
const aKey = process.argv[2] ?? 'aggressor';
const bKey = process.argv[3] ?? 'gambler';
const map = (process.argv[4] ?? 'classic') as MapKind;
const aVer = Number(process.argv[5] ?? 2);
const bVer = Number(process.argv[6] ?? 1);

function controller(ver: number, key: string, seed: number, slot: number): IBotController {
  const spec: BotSpec = { difficulty: 'normal', strategyRaw: key };
  return AI_VERSIONS[ver]!.createBot(seed, slot, spec);
}

function classicSeed(repeat: number): number {
  return (BASE + 0 * 5 + repeat) >>> 0; // mapIndex 0 = classic
}

console.log(`PROBE ${map}: slot0=v${aVer}-${aKey}  vs  slot1=v${bVer}-${bKey}`);
console.log(
  'seed     winner  | s0: bombs broke fire can spd elim | s1: bombs broke fire can spd elim',
);

for (let r = 0; r < 10; r++) {
  const seed = classicSeed(r);
  let state: SimState = createInitialState(seed, makeFeelParams(), 2, {
    pvp: true,
    teams: [0, 1],
    map,
  });
  const ctrls = [controller(aVer, aKey, seed, 0), controller(bVer, bKey, seed, 1)];
  const bombs = [0, 0];
  const broke = [0, 0];
  const elim = [-1, -1];

  let prevSoftRemaining = -1;
  while (state.phase === GamePhase.PLAYING && state.tick < MAX_TICKS) {
    const frame: InputFrame[] = [];
    for (let s = 0; s < 2; s++) {
      const f = ctrls[s]!.sample(state, s);
      // Count a bomb ATTEMPT whenever the controller raises the BOMB flag while it
      // still has a free cannon (so it would actually drop).
      if ((f.action & ActionFlags.BOMB) !== 0) bombs[s]! += 1;
      frame.push(f);
    }
    state = tick(state, frame);
    for (let s = 0; s < 2; s++) {
      if (elim[s] === -1 && !state.players[s]!.alive) elim[s] = state.tick;
    }
  }
  void prevSoftRemaining;

  const endTick = state.tick;
  for (let s = 0; s < 2; s++) if (elim[s] === -1) elim[s] = endTick;

  // soft bricks broken: approximate by each player's fire growth is wrong; instead
  // we don't have per-player brick attribution cheaply, so leave broke as 0 (the
  // fire/cannon/spd development + bombs columns are the real signal).
  void broke;

  let winner = 'draw';
  const a0 = state.players[0]!.alive;
  const a1 = state.players[1]!.alive;
  if (a0 && !a1) winner = 's0';
  else if (a1 && !a0) winner = 's1';
  else if (a0 && a1) winner = 'cap';

  const dev = (s: number): string => {
    const p = state.players[s]!;
    const fire = p.fire;
    const can = p.cannon;
    const spd = Math.trunc((p.speedBonusTenths - PLAYER_START_SPEED_BONUS) / 4);
    return `${String(bombs[s]).padStart(5)} ${String(0).padStart(5)} ${String(fire).padStart(4)} ${String(can).padStart(3)} ${String(spd).padStart(3)} ${String(elim[s]).padStart(4)}`;
  };
  void PLAYER_START_FIRE;
  void PLAYER_START_CANNON;

  console.log(`${String(seed).padStart(8)} ${winner.padStart(6)}  | s0: ${dev(0)} | s1: ${dev(1)}`);
}

if (process.env.SURV_DEBUG) {
  const g = globalThis as any;
  console.error(
    `[surv stats] n=${g.__surv_n} worstSurv range [${g.__surv_min}, ${g.__surv_max}]`,
  );
  const ok = g.__gate_ok ?? 0;
  const no = g.__gate_no ?? 0;
  console.error(
    `[gate stats] bombGateOk pass=${ok} fail=${no} passRate=${((100 * ok) / Math.max(1, ok + no)).toFixed(1)}%`,
  );
  const act = g.__act ?? [0, 0, 0, 0, 0, 0];
  const dec = g.__decisions ?? 1;
  console.error(
    `[action dist] decisions=${dec} STAY=${act[0]} UP=${act[1]} DOWN=${act[2]} LEFT=${act[3]} RIGHT=${act[4]} BOMB=${act[5]} bombLegal=${g.__bomb_legal ?? 0} | BOMB%=${((100 * act[5]) / dec).toFixed(2)}`,
  );
}
