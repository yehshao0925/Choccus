/**
 * MapProfile — the per-map tuning seam for the v2/v3 forward-search bot.
 *
 * v2 (depth-4 forward-search maximin) dominates the open PIRATE map but freezes
 * on the closed CLASSIC map (a "defer-forever / spawn-deadlock" degeneracy). To
 * let the two maps DIVERGE later without regressing each other, the bot is split
 * into a map-agnostic ENGINE (core/) plus one MapProfile instance per map. The
 * live BotController reads `SimState.mapKind` once and feeds the matching
 * profile's knobs into the core search / growth gate.
 *
 * THIS IS THE STRUCTURAL SEAM ONLY for the NEUTRAL v2 knobs. Both profiles hold
 * the SAME neutral values for those, chosen so the engine behaves BYTE-IDENTICALLY
 * to committed v2 (git HEAD): with these neutral values every knob is a no-op
 *   - deferredBombDiscountPct 0 → the deferred-bomb reward discount is identity;
 *   - stayPenalty 0            → no flat STAY penalty is subtracted;
 *   - survEnough MAX_SAFE_INTEGER → the survivability clamp `min(surv, enough)`
 *     never bites (surv is always far below it);
 *   - deadlockGrowthRelease false → `inPlaceBricksForGrowth === inPlaceBricks`,
 *     i.e. the HEAD growth-suppression rule is unchanged.
 * A LATER per-map tuning pass can flip CLASSIC's values (e.g. to close the
 * defer-forever degeneracy) without touching core/ or pirate/.
 *
 * v3 ADDS the CONNECTIVITY DOCTRINE knobs (`growUntilConnected` /
 * `isolatedDevFloor`) on top of that same v2 seam: while the bot has no open
 * walkable path to any foe it is "isolated" / pre-connection (combat impossible),
 * so the effective development factor is floored — the bot FARMS TO COMPLETION
 * instead of tapering at mid-development (the v2 flaw) — and snaps back to the v2
 * readiness model the instant an open path to a foe appears. With
 * `growUntilConnected:false` these knobs are inert and behaviour is exactly v2.
 *
 * PURE / determinism-safe: a MapProfile is a frozen bag of integers / booleans —
 * no RNG, no wall-clock, no irrational math. It only ever shifts INTEGER scores.
 *
 * MapProfile（v2/v3 前瞻 bot 的「每地圖調參接縫」）：把 bot 拆成與地圖無關的引擎
 * （core/）＋每張地圖一份 profile。中性 v2 旋鈕兩份 profile 數值相同，使引擎行為
 * 與 committed v2（git HEAD）逐位元相同；日後可單獨翻 classic 的數值而不動
 * core/ 或 pirate/。v3 在同一接縫上再加「連通性教條」旋鈕（growUntilConnected／
 * isolatedDevFloor）：當 bot 與任何敵人之間沒有開放可走路徑時視為「孤立／未連通」
 * （無法交戰），把有效發育係數鎖到地板 → 發育到完成（修正 v2 中段就收手的缺陷），
 * 一旦出現通往敵人的開放路徑就立刻切回 v2 就緒度模型。純函式、無 RNG、只移動整數分數。
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
  /**
   * CONNECTIVITY DOCTRINE master switch (v3). When true, the bot honours
   * "grow-until-contact, then engage": while there is NO open walkable path to
   * any live attackable foe (BFS over open passability hit the foeDist cap → the
   * bot is isolated / pre-connection, so combat is impossible), the effective
   * development factor is forced to at least `isolatedDevFloor`, keeping the
   * economy boost + growth pull at full strength so the bot FARMS TO COMPLETION
   * instead of tapering once mid-developed (the v2 flaw). The instant an open
   * path to a foe exists (foeDist < cap) the bot drops straight back to the v2
   * readiness model. false = HEAD/v2 behaviour (`isolated` is always false → the
   * effective development factor equals the real readiness, byte-identical to v2).
   */
  readonly growUntilConnected: boolean;
  /**
   * Floor (integer 0..100) the EFFECTIVE development factor is forced to while
   * the bot is isolated (no open path to any foe) AND `growUntilConnected` is on.
   * 100 = farm at maximum priority until connected (econ boost maxed, growth pull
   * maxed, attack cut maxed) — the purest expression of the doctrine. Only ever
   * RAISES the effective factor (`Math.max(devFactor, isolatedDevFloor)`), never
   * lowers it, and only applies while isolated and not close-quarters-engaged.
   */
  readonly isolatedDevFloor: number;
  /**
   * Survivability clamp ceiling used ONLY while isolated (replaces `survEnough`
   * in the forward search for that decision). While isolated the ONLY danger is
   * the bot's OWN bombs, and every bomb already passes the pessimistic refuge
   * GATE (a real escape route is guaranteed) — so the survivability-FLOOD
   * magnitude (how much breathing room) should not veto a productive bomb. A low
   * value clamps min(surv, isolatedSurvEnough) so a gate-approved bomb's small
   * post-bomb survivability dip ties with idling, letting the farming REWARD
   * decide → the bot keeps clearing bricks instead of freezing. Applies ONLY
   * while isolated (and growUntilConnected on); the connected/engage phase keeps
   * the full `survEnough` caution. MAX_SAFE_INTEGER = no isolated clamp.
   */
  readonly isolatedSurvEnough: number;
  /**
   * Proximity (BFS open-path hops to the nearest foe) UNDER which the bot reverts
   * to full `survEnough` caution; at/above it the low `isolatedSurvEnough` clamp
   * applies (aggressive farming). Decouples "farm aggressively" from binary
   * connection — a foe can be reachable yet many hops away on a closed lattice —
   * so the bot keeps farming throughput everywhere except genuine close quarters,
   * which is where it was dying to wall-offs. LARGER = caution triggers sooner
   * (safer vs an approaching aggressor, but less late-game farming).
   */
  readonly cautionDist: number;
  /**
   * When true, once CONNECTED to a foe (within cautionDist) AND ahead on total
   * pickups, the bot is pulled AWAY from the foe (a retreat term) to preserve its
   * winning development lead instead of getting cornered and killed — the closed
   * map is a development race where an aggressive engage loses to the wall-off, so
   * the winning play is "out-develop, then don't die". false = no retreat bias.
   */
  readonly protectLead: boolean;
  /**
   * When true, the bot may PACK a brick cluster by dropping additional bombs
   * while retreating (using spare cannons), each re-validated by the SAME refuge
   * gate single bombs pass (so it cannot self-trap) and only in a safe farming
   * context (no foe within cautionDist). This lifts farming from single-bomb
   * throughput toward parallel-bomb throughput on the closed lattice. false =
   * one-bomb-then-flee (v2 behaviour).
   */
  readonly multiBombFarm: boolean;
}
