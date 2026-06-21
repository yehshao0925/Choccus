/**
 * AI version registry. Each client/src/ai/vN/ folder is an independent,
 * co-equal snapshot of the bot's decision logic (the versions ARE the
 * persistence mechanism — there is no separate frozen baseline). They share the
 * sim-aligned perception layer in client/src/ai/common/. This module exposes a
 * version-agnostic factory so callers (main.ts, sim-runner) never import a
 * version folder directly and never depend on any version's BotTuning shape.
 *
 * To add a version: create client/src/ai/vN+1/ (copy the latest, evolve its
 * decision logic), add an adapter module like vN/module.ts, then register it in
 * AI_VERSIONS and bump LATEST_AI_VERSION.
 */
import type { IBotController } from './common/IBotController';
import { v1Module } from './v1/module';
import { v2Module } from './v2/module';
import { v3Module } from './v3/module';
import { v4Module } from './v4/module';

/**
 * Caller-supplied bot configuration, version-agnostic. `strategyRaw` is the raw
 * lower-cased/trimmed ?strategy= value ('' → difficulty fallback; an archetype
 * key; or 'mix'/'random'); `difficulty` is the raw ?difficulty= value. Each
 * version module parses these exactly as solo mode does.
 */
export interface BotSpec {
  difficulty: string;
  strategyRaw: string;
}

/** One AI version's adapter: build a bot and name a bot slot from a BotSpec. */
export interface AiVersionModule {
  readonly version: number;
  /** Archetype keys this version actually defines (for UI pickers). */
  readonly strategyKeys: readonly string[];
  createBot(matchSeed: number, slot: number, spec: BotSpec): IBotController;
  botNameFor(slot: number, spec: BotSpec): string;
}

/** Every known AI version, keyed by its AI_VERSION number. */
export const AI_VERSIONS: Readonly<Record<number, AiVersionModule>> = Object.freeze({
  [v1Module.version]: v1Module,
  [v2Module.version]: v2Module,
  [v3Module.version]: v3Module,
  [v4Module.version]: v4Module,
});

/** The newest registered AI version (the default for live play and tools). */
export const LATEST_AI_VERSION: number = Math.max(
  ...Object.keys(AI_VERSIONS).map(Number),
);

export type { IBotController } from './common/IBotController';

/**
 * Re-export the latest version's difficulty parser so callers can normalize a
 * ?difficulty= value (for HUD text) without importing a version folder.
 */
export { parseDifficulty } from './v4/BotConfig';
