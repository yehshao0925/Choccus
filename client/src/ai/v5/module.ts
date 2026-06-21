/**
 * v5 adapter implementing the shared AiVersionModule contract (see ../index.ts).
 * Wires this folder's OWN BotController / BotConfig / Strategies / version into
 * the version-agnostic registry. All strategy/tuning/name resolution mirrors the
 * solo-mode logic in main.ts byte-for-byte; only the version module differs.
 */
import type { AiVersionModule, BotSpec } from '../index';
import type { IBotController } from '../common/IBotController';
import { BotController } from './BotController';
import { botSeed, parseDifficulty, tuningFor, type BotTuning } from './BotConfig';
import { STRATEGIES, resolveStrategy, strategyForSlot } from './Strategies';
import { AI_VERSION } from './version';

/** Capitalize a difficulty string for display (mirrors main.ts `cap`). */
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Resolve the tuning for a bot slot from a spec (mirrors main.ts tuningForSlot). */
function tuningForSlot(spec: BotSpec, slot: number): BotTuning {
  const isMix = spec.strategyRaw === 'mix' || spec.strategyRaw === 'random';
  if (isMix) return strategyForSlot(slot - 1).tuning;
  const named = spec.strategyRaw === '' ? undefined : resolveStrategy(spec.strategyRaw);
  if (named !== undefined) return named.tuning;
  return tuningFor(parseDifficulty(spec.difficulty));
}

export const v5Module: AiVersionModule = {
  version: AI_VERSION,
  strategyKeys: STRATEGIES.map((s) => s.key),

  createBot(matchSeed: number, slot: number, spec: BotSpec): IBotController {
    return new BotController(botSeed(matchSeed, slot), tuningForSlot(spec, slot), slot);
  },

  botNameFor(slot: number, spec: BotSpec): string {
    const isMix = spec.strategyRaw === 'mix' || spec.strategyRaw === 'random';
    if (isMix) return strategyForSlot(slot - 1).name;
    const named = spec.strategyRaw === '' ? undefined : resolveStrategy(spec.strategyRaw);
    if (named !== undefined) return named.name;
    return cap(parseDifficulty(spec.difficulty));
  },
};
