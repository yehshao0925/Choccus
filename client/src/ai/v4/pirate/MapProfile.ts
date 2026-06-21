/**
 * PIRATE map profile for the v2 forward-search bot.
 *
 * NEUTRAL today (every knob a no-op) → the engine behaves byte-identically to
 * committed v2 on the pirate map, where v2's forward-search already dominates.
 * Values are IDENTICAL to the classic profile for now; a later per-map pass may
 * keep these neutral while only classic diverges, all without touching core/.
 *
 * pirate 地圖 profile：v2 旋鈕全中性（== HEAD），與 classic 數值相同。
 *
 * v3 enables the CONNECTIVITY DOCTRINE here too (growUntilConnected ON,
 * isolatedDevFloor 100): the bot farms to completion while it has no open path to
 * any foe, then reverts to the v2 readiness model once a path opens.
 * v3 在此也開啟「連通性教條」（growUntilConnected 開、isolatedDevFloor 100）：與任何敵人
 * 無開放路徑時發育到完成，一旦出現路徑就切回 v2 就緒度模型。
 */
import type { MapProfile } from '../MapProfile';

export const PIRATE_PROFILE: MapProfile = Object.freeze({
  map: 'pirate',
  deferredBombDiscountPct: 0,
  stayPenalty: 0,
  survEnough: Number.MAX_SAFE_INTEGER,
  deadlockGrowthRelease: false,
  // CONNECTIVITY DOCTRINE (v3): farm to completion while isolated (no open path
  // to any foe), flooring the effective development factor at the maximum.
  growUntilConnected: true,
  isolatedDevFloor: 100,
  // While isolated/far from a foe, clamp survivability low so a gate-approved bomb
  // beats idling on the farming reward (same rationale as classic).
  isolatedSurvEnough: 8,
  // Full caution within this many open-path hops of a foe (else farm aggressively).
  cautionDist: 6,
  // Pirate has real kills and v3 already passes there; keep the aggressive engage
  // (no lead-protection retreat) so as not to disturb the passing pirate result.
  protectLead: false,
  // Parallel-bomb cluster farming while retreating (gate-validated, far-from-foe).
  multiBombFarm: true,
});
