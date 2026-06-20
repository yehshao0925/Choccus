/**
 * CLASSIC map profile for the v2 forward-search bot.
 *
 * TUNED (2026-06-19) — v2 now WINS the closed classic map. classic is a pure
 * development race (1v1s almost never end in a kill; the tick-cap item-progress
 * tiebreak decides), and committed v2 froze there via "defer-forever": the search
 * takes a root action's score as the MAX over its own continuations, so STAY-then-
 * bomb-later tied bomb-now and the first-in-order STAY won ~85-93% of decisions
 * (BOMB ~0.1%). Two knobs fix it, both validated by the classic 1v1 round-robin
 * (`tools/sim-runner/src/sweep-classic.ts`, repeats=15):
 *
 *  - `deadlockGrowthRelease` ON breaks the spawn-pocket death-lock (an in-place
 *    fire-2 bomb covers the whole L-pocket → gate rejects it → growth suppression
 *    used to freeze the bot; now it repositions to a tile it CAN safely bomb).
 *  - `deferredBombDiscountPct: 100` kills defer-forever: a bomb dropped at search
 *    depth d keeps max(0, 100 - 100·d)% of its reward, i.e. ONLY an immediately-
 *    dropped (root, depth-0) bomb earns search reward; every deferred bomb earns
 *    zero. So "bomb now" strictly beats "wander then bomb later" and the bot
 *    farms at tempo instead of stalling.
 *
 * Result (8-agent 1v1 round-robin on classic, repeats=15): ALL FOUR v2 archetypes
 * now outrank ALL FOUR v1 archetypes — rank-1 v2-Chaosv 58.1% (was v1 champion;
 * committed v2 held #5-8). `stayPenalty` and `survEnough` were swept too and left
 * NEUTRAL: survEnough never bit (closed-map survivability differences don't flip
 * the argmax) and a flat STAY penalty hurt the other v2 archetypes. The pirate
 * profile is untouched (stays neutral), so this only changes classic decisions —
 * pirate's v2-Aggressor champion (69.3%) is byte-unchanged.
 *
 * classic 地圖 profile（已調參）：classic 是純發育競賽，committed v2 因「延後一樣好」
 * 退化而凍結。deadlockGrowthRelease 治出生角死鎖、deferredBombDiscountPct=100 讓
 * 「只有當下放的彈才算搜尋 reward」→ 殺掉 defer-forever。結果四個 v2 全壓過四個 v1
 * （rank-1 v2-Chaosv 58.1%）。survEnough/stayPenalty 掃過無益，維持中性。pirate 不動。
 *
 * v3 layers the CONNECTIVITY DOCTRINE on top here (growUntilConnected ON,
 * isolatedDevFloor 100): while isolated the bot farms to completion, then snaps
 * back to the v2 readiness model once an open path to a foe opens.
 * v3 在此再疊上「連通性教條」（growUntilConnected 開、isolatedDevFloor 100）：孤立時
 * 發育到完成，一旦出現通往敵人的開放路徑就切回 v2 就緒度模型。
 */
import type { MapProfile } from '../MapProfile';

export const CLASSIC_PROFILE: MapProfile = Object.freeze({
  map: 'classic',
  // Only an immediately-dropped bomb earns search reward (deferred bombs → 0%):
  // the validated cure for the defer-forever degeneracy. Swept across 0..100;
  // the 70..100 plateau gives a complete v2 sweep of the classic top-4, 100 the
  // strongest + cleanest ("bomb-now-only"). See the header for the full rationale.
  deferredBombDiscountPct: 100,
  stayPenalty: 0,
  // Full survivability caution ONLY when a foe is genuinely close (< CAUTION_DIST
  // hops) — that close-quarters phase is where v3 was dying to v2's wall-off. Far
  // from any foe (the long isolated farming phase + a connected-but-distant foe)
  // the bot uses the low `isolatedSurvEnough` clamp below and farms aggressively.
  survEnough: Number.MAX_SAFE_INTEGER,
  // Validated: release growth suppression when an in-place bomb is gated out (no
  // escape), so the bot steps to a tile it CAN safely bomb from (spawn-pocket fix).
  deadlockGrowthRelease: true,
  // CONNECTIVITY DOCTRINE (v3): farm to completion while isolated (no open path
  // to any foe), flooring the effective development factor at the maximum.
  growUntilConnected: true,
  isolatedDevFloor: 100,
  // While isolated, clamp survivability low so a gate-approved bomb's small
  // post-bomb surv dip never vetoes a productive brick bomb — the farming reward
  // decides → the bot keeps clearing the closed lattice instead of freezing.
  // Measured (v3-diag, classic gate): vs no clamp this lifts itemScore Δ +1.8→+2.4
  // and more-items 64%→75%. Only active while isolated.
  isolatedSurvEnough: 8,
  // Full caution kicks in when a foe is within this many open-path hops (else the
  // bot farms aggressively). Tuned for the closed lattice where v2-ChaosV's
  // wall-off is the main death cause; see the sweep in tools/sim-runner.
  cautionDist: 6,
  // Once connected AND ahead on pickups, back away from the foe to preserve the
  // development lead (engaging the wall-off loses on classic).
  protectLead: true,
  // Pack brick clusters with parallel bombs (spare cannons) while retreating —
  // the closed lattice is a development race, so doubling farming throughput is
  // the biggest remaining lever. Each extra bomb passes the full refuge gate.
  multiBombFarm: true,
});
