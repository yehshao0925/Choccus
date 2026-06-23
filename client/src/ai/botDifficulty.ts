/**
 * Bot difficulty = a rung on the Bradley-Terry strength ladder (NOT the
 * reaction-lag DIFFICULTY_PRESET handicaps). Each tier picks a real, measured
 * roster bot whose bot-vs-bot Elo is well separated from its neighbours, so
 * "strength" means an actually-weaker/stronger opponent rather than a guessed
 * handicap. Hard = the map champion (mapChampions.ts).
 *
 * Approx BT-Elo of the chosen rungs (tools/sim-runner bt-history):
 *   classic  reactive 1163  ·  runner 1468  ·  zoner(v5) 1788
 *   pirate   reactive  870  ·  runner 1603  ·  zoner(v4) 1788
 * Spread is map-uneven (the mid roster is clustered/non-transitive); the local
 * DDA (net/dda.ts) fills the perceptual gaps. Archetypes here are tunable —
 * they are BT rungs, not human-feel-tuned.
 */
import type { MapKind } from '../sim/Map';
import { championFor } from './mapChampions';

export type BotTier = 'easy' | 'normal' | 'hard';

export const BOT_TIERS: readonly BotTier[] = ['easy', 'normal', 'hard'];

/** Normalize an arbitrary wire string to a known tier (default 'normal'). */
export function asTier(raw: string | undefined): BotTier {
  return raw === 'easy' || raw === 'hard' ? raw : 'normal';
}

/** Resolve a tier + map to a concrete bot { version, archetype }. */
export function botForTier(
  tier: BotTier,
  map: MapKind,
): { version: number; archetype: string } {
  if (tier === 'hard') return championFor(map);
  if (tier === 'easy') return { version: 3, archetype: 'reactive' };
  return { version: 3, archetype: 'runner' }; // normal
}
