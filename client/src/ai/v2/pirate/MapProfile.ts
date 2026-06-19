/**
 * PIRATE map profile for the v2 forward-search bot.
 *
 * NEUTRAL today (every knob a no-op) → the engine behaves byte-identically to
 * committed v2 on the pirate map, where v2's forward-search already dominates.
 * Values are IDENTICAL to the classic profile for now; a later per-map pass may
 * keep these neutral while only classic diverges, all without touching core/.
 *
 * pirate 地圖 profile：目前全中性（== HEAD），與 classic 數值相同。
 */
import type { MapProfile } from '../MapProfile';

export const PIRATE_PROFILE: MapProfile = Object.freeze({
  map: 'pirate',
  deferredBombDiscountPct: 0,
  stayPenalty: 0,
  survEnough: Number.MAX_SAFE_INTEGER,
  deadlockGrowthRelease: false,
});
