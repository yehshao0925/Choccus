/**
 * MapProfile — the per-map tuning seam for the v2 forward-search bot.
 *
 * v2 (depth-4 forward-search maximin) dominates the open PIRATE map but freezes
 * on the closed CLASSIC map (a "defer-forever / spawn-deadlock" degeneracy). To
 * let the two maps DIVERGE later without regressing each other, the bot is split
 * into a map-agnostic ENGINE (core/) plus one MapProfile instance per map. The
 * live BotController reads `SimState.mapKind` once and feeds the matching
 * profile's knobs into the core search / growth gate.
 *
 * THIS IS THE STRUCTURAL SEAM ONLY. Both profiles currently hold the SAME
 * NEUTRAL values, chosen so the engine behaves BYTE-IDENTICALLY to committed v2
 * (git HEAD): with these neutral values every knob is a no-op
 *   - deferredBombDiscountPct 0 → the deferred-bomb reward discount is identity;
 *   - stayPenalty 0            → no flat STAY penalty is subtracted;
 *   - survEnough MAX_SAFE_INTEGER → the survivability clamp `min(surv, enough)`
 *     never bites (surv is always far below it);
 *   - deadlockGrowthRelease false → `inPlaceBricksForGrowth === inPlaceBricks`,
 *     i.e. the HEAD growth-suppression rule is unchanged.
 * A LATER per-map tuning pass can flip CLASSIC's values (e.g. to close the
 * defer-forever degeneracy) without touching core/ or pirate/.
 *
 * PURE / determinism-safe: a MapProfile is a frozen bag of integers / booleans —
 * no RNG, no wall-clock, no irrational math. It only ever shifts INTEGER scores.
 *
 * MapProfile（v2 前瞻 bot 的「每地圖調參接縫」）：把 bot 拆成與地圖無關的引擎
 * （core/）＋每張地圖一份 profile。目前兩份 profile 數值「完全中性」，使引擎
 * 行為與 committed v2（git HEAD）逐位元相同；日後可單獨翻 classic 的數值而不動
 * core/ 或 pirate/。純函式、無 RNG、只移動整數分數。
 */

/**
 * A per-map bag of decision knobs the v2 core reads. All NEUTRAL today (== HEAD).
 * Add NEW per-map knobs here (with a neutral default in both instances) as the
 * later tuning pass needs them — never read `process.env` in the live AI path.
 */
export interface MapProfile {
  /** Which map this profile governs (matches SimState.mapKind for these two). */
  readonly map: 'classic' | 'pirate';
  /**
   * Depth discount (PERCENT per ply) applied to a DEFERRED bomb's reward inside
   * the forward search: a bomb dropped at search depth d keeps only
   * max(0, 100 - pct*d)% of its reward, so "bomb now" can outscore "wander then
   * bomb later". 0 = identity (no discount) → HEAD behavior.
   */
  readonly deferredBombDiscountPct: number;
  /**
   * Flat INTEGER penalty subtracted from the STAY root action's final score
   * (anti defer-forever). 0 = no penalty → HEAD behavior.
   */
  readonly stayPenalty: number;
  /**
   * Survivability clamp ceiling: a leaf's worst-case survivability is taken as
   * min(surv, survEnough) before weighting, so beyond this many safe ticks extra
   * safety stops out-voting reward. MAX_SAFE_INTEGER = clamp never bites → HEAD.
   */
  readonly survEnough: number;
  /**
   * When true, an in-place bomb that the safety gate REJECTS (no escape route)
   * no longer suppresses the growth / reposition pull — the bot is freed to step
   * to an adjacent tile from which the same bricks ARE safely bombable (the
   * classic spawn-pocket deadlock fix). false = HEAD behavior
   * (inPlaceBricksForGrowth === inPlaceBricks).
   */
  readonly deadlockGrowthRelease: boolean;
}
