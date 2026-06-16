/**
 * Version-agnostic public surface of a bot brain. Every AI version's
 * BotController satisfies this (constructors and tuning shapes differ per
 * version and stay private behind each version's factory in index.ts). Callers
 * (main.ts, sim-runner) drive bots solely through `sample`.
 */
import type { InputFrame } from '../../sim/InputBuffer';
import type { SimState } from '../../sim/Sim';

export interface IBotController {
  sample(state: SimState, slot: number): InputFrame;
}
