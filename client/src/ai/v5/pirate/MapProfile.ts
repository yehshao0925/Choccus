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
  // Kill phase engages at the global default (≈40 s) — neutral, pirate is untouched.
  huntStartTick: 2400,
  // No ring override (archetype default). Tightening to 3 traded trapper away
  // (59->54) for farmer (55->58) with the mirror flat — net neutral/negative, the
  // same trapper trade-off that caps the lead. Keep the wider default.
  zoneStandoffTiles: 0,
  // SUDDEN-DEATH SURVIVAL (v4-pirate): the main mirror-breaker here (zoner 50->58
  // at weight 4). Push to 6 — the open-map mirror responded strongly, so a
  // stronger center pre-position extends the lead. Measured sweet spot: 6.
  // weight 4: zoner 58 | weight 6: zoner 60, trapper 58 | weight 8: zoner 62 but
  // trapper 54 (over-centralizing neglects the trapper fight — net wash, less
  // robust). 6 keeps every top matchup healthy. weight 7 also drops trapper
  // (58->55) with no mirror gain — 6 is the confirmed peak (+48 lead).
  shrinkSurvivalWeight: 6,
  // Mid cannon dev target (shared default). RAISING to 4 was measured a WASH on
  // the pirate mirror (still exactly 50.0% over 120 games) and the v4 analysis
  // found it farmer-negative on the ladder — the symmetric mirror does not reward
  // out-developing. Keep 3.
  devTargetCannon: 3,
  // No corner-finish on pirate: measured neutral-to-negative on the open map
  // (farmer 55->53, mirror/trapper flat) — rarely fires and diving adds risk.
  cornerFinish: false,
  // GROW A LONGER BLAST (v4-pirate): port the classic winner — drive the fire dev
  // target to the new max 7 so the bot builds the longest cross (stronger kills /
  // seals on the open map too). Few pickups → no over-farming. Under bench.
  devTargetFire: 7,
  // Default early-economy boost (2x) — pirate byte-unchanged.
  devEconBoostMax: 100,
  // Default seal weight — pirate byte-unchanged.
  sealWeightMult: 100,
  // v5 ANTI-ENTRAPMENT (NEW defensive axis): penalise dead-end / single-exit
  // result tiles while a foe is near (mostly inert on the open map, but free).
  entrapWeight: 10,
  // v5 ROBUST REFUGE: OFF on pirate — on the open map the mirror edge it buys is
  // coupled to a farming-tempo loss vs the v3 dev-racers (pirate BT 1809->1766);
  // pirate wins the ladder via the entrap term alone (BT #1, +22 over v4).
  robustRefuge: false,
  // v5 CORRIDOR-AWARE BOMB GATE: OFF on pirate. Tested true (v5-trace shows pirate
  // also self-seals in the shrink pocket): it LIFTS trapper 59.4->62.5 and farmer,
  // but DROPS the v4 mirror 50.6->47.5 (fails the ship gate) — on the open symmetric
  // mirror it only vetoes the bot's own useful bombs and can't touch the real death
  // (the shrink wall, not a foe seal). So pirate keeps false; classic-only win.
  corridorGate: false,
});
