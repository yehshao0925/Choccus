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
  /**
   * Tick at which the KILL-DOCTRINE clock urgency lifts off 0 and starts ramping
   * to 100 (at the fixed tick cap). Until this tick the close-quarters
   * survivability clamp stays at FULL caution (`survEnough`), so the bot refuses
   * to trade its own safety for a foe-compressing / sealing bomb; from here the
   * clamp loosens toward HUNT_SURV_FLOOR and farming fades, i.e. this is WHEN the
   * bot switches from "develop a kit safely" to "convert position into kills".
   * SMALLER = engage the kill phase EARLIER (more kills, more own-risk). The
   * pirate-neutral value equals the global T_HUNT_START (2400 ≈ 40 s); classic
   * lowers it because the cramped lattice forces contact sooner and would
   * otherwise mirror to a sudden-death coin-flip instead of a clean kill.
   */
  readonly huntStartTick: number;
  /**
   * Per-map override for the 控場流 Zoner stand-off ring radius (tiles). The Zoner
   * rewards tiles whose Manhattan distance to the foe is nearest this radius, so a
   * SMALLER radius pulls it to compress into kill range rather than orbit at arm's
   * length. 0 = no override (use the archetype's own `tuning.zoneStandoff`).
   * Pirate leaves it 0 (the open map's wider ring already wins); classic tightens
   * it because orbiting a near-peer on the cramped lattice just mirrors to a
   * sudden-death coin-flip — closing the ring is how the Zoner actually kills.
   */
  readonly zoneStandoffTiles: number;
  /**
   * Weight of the SUDDEN-DEATH SURVIVAL pull (0 = off). As the arena shrink nears,
   * every leaf gains `weight × tileSurvivalRank × proximity%` where the rank is how
   * LATE that tile hardens in the inward spiral (center last). This makes the bot
   * drift toward the surviving center BEFORE the wall arrives — the AI otherwise
   * only sees already-hardened tiles and never anticipates the shrink, so on the
   * cramped classic map near-peer mirrors coin-flip the shrink endgame. Pirate
   * keeps it 0 (open map already won; don't perturb it); classic turns it on as
   * the main lever to break those endgame ties. The hard refuge gate is unchanged
   * — this only biases WHICH safe tile is preferred, never overrides safety.
   */
  readonly shrinkSurvivalWeight: number;
  /**
   * CANNON development target (upgrade points) used by the development factor: the
   * bot keeps the economy boost + brick-clearing growth pull at strength until its
   * cannon count reaches this, then declares itself "developed". The shared default
   * is 3 (mid), which means the bot never accumulates the cannon SURPLUS needed to
   * wall a corner with 5-6 bombs (the offensive multi-bomb pincer is starved of
   * cannons). Classic raises it to the max (PLAYER_MAX_CANNON=5) so the bot farms
   * to a real surplus and can box a cornered foe; pirate keeps the mid default.
   */
  readonly devTargetCannon: number;
  /**
   * CORNER-FINISH (v4-classic). When true, the moment the nearest attackable foe
   * is in reach AND its free space has collapsed (cornered / dead-ended), the
   * 控場流 Zoner stand-off ring collapses to 1 so the bot dives in to SEAL the
   * cornered foe with the offensive multi-bomb pincer rather than orbiting at the
   * ring while the foe escapes — turning "herd toward a corner" into an actual
   * kill. The hard refuge gate is unchanged (the bot still needs an escape).
   * false = the ring radius is never overridden by foe mobility.
   */
  readonly cornerFinish: boolean;
  /**
   * FIRE development target (blast radius the bot grows toward before declaring
   * itself developed; also the threshold past which fire pickups are de-prioritised).
   * Shared default 4 (of max 6). Classic raises it: a longer blast cross makes
   * seals and corner-walls cover more exits and reach fleeing foes, strengthening
   * the kill phase. Unlike cannon, fire is far fewer pickups so raising it does not
   * trigger the over-farming that a higher cannon target did.
   */
  readonly devTargetFire: number;
  /**
   * Max early-economy boost (PERCENT) applied to brick-farming value when freshly
   * spawned, fading linearly to 0 as the bot develops / a foe engages. Shared
   * default 100 (up to 2x). Classic raises it so the bot farms harder in the
   * opening and reaches its kit (notably the long fire-6 blast) FASTER than the
   * v3 peers that share the base value — out-develop, then enter combat ahead.
   * Only affects the isolated early phase (effDevFactor>0); 0 once engaged.
   */
  readonly devEconBoostMax: number;
  /**
   * SEAL reward multiplier (PERCENT, 100 = unscaled). Scales the W_SEAL term that
   * rewards compressing/sealing a foe's refuge (which already accounts for bricks
   * blocking the blast and every live bomb incl. the foe's own). Classic raises it
   * so the bot commits harder to closing a trap rather than orbiting at the ring —
   * killing power aimed at the aggressive trapper matchup. Pirate keeps 100.
   */
  readonly sealWeightMult: number;
  /**
   * v5 ANTI-ENTRAPMENT weight (0 = off, the v4 neutral). A NEW, DEFENSIVE,
   * orthogonal axis the v4 ceiling analysis never explored. While an attackable
   * foe is within combat range, every leaf is penalised by
   *   entrapWeight × max(0, ENTRAP_BRANCH_TARGET − escapeBranches(resultTile))
   *                × proximity
   * where escapeBranches counts the DISTINCT safe escape branches out of the
   * result tile (a dead-end / single-exit pocket has ≤1). This biases the bot AWAY
   * from tiles a single foe follow-up bomb can seal — exactly the failure the user
   * reported (v4 ducks into dead-ends / stands in single-exit pockets and dies to
   * one follow-up bomb) and exactly the mechanism v3:trapper's vChain seal exploits
   * (the binding ceiling matchup). It only shifts WHICH safe tile is preferred when
   * a foe is near; it never touches the hard refuge gate or survivability flood, so
   * it cannot make the bot suicidal. Tuned per map.
   */
  readonly entrapWeight: number;
  /**
   * v5 ROBUST REFUGE selection (per map). When true, the post-bomb COMMIT paths
   * (final bomb emit + the two multi-bomb anchors) do NOT stop at the nearest
   * valid refuge — they scan all valid refuges within maxEscapeLen and run to the
   * one with the MOST escape branches (tie → nearest), so the bot flees a bomb to
   * a junction rather than a single-exit pocket a follow-up bomb can seal. The
   * cheap boolean bomb-GATE always uses the nearest-refuge fast path regardless.
   * CLASSIC on: a pure win on the closed map (BT +49->+62 over v4, mirror
   * 52.5%->55.6%). PIRATE off: on the open map chasing a far high-branch refuge
   * bleeds farming tempo vs the v3 dev-racers (pirate BT 1809->1766), and the
   * open-map mirror edge is coupled to that tempo cost — so pirate wins the ladder
   * via the entrap term alone (BT #1, +22). false = nearest refuge (v4 behaviour).
   */
  readonly robustRefuge: boolean;
  /**
   * v5 CORRIDOR-AWARE BOMB GATE (per map). When true, a PLACE_BOMB is only allowed
   * if — while an attackable foe is within combat range — its validated refuge has
   * at least ENTRAP_BRANCH_TARGET (2) independent escape branches, i.e. it is a
   * JUNCTION, not a single-exit corridor. Rationale (v5-trace, classic): the bot's
   * deaths are the trapper's 1-wide-corridor vChain seal — the foe herds it into a
   * vertical corridor, caps one end with follow-up bombs, and the bot's own retreat
   * bombs cap the other. The existing pessimistic gate models the foe bombing from
   * its CURRENT tile (and only with a free cannon), so it misses the foe ADVANCING
   * along the escape corridor to cap it (and mid-vChain the foe has no free cannon).
   * This gate refuses to commit a bomb whose only escape is a cappable corridor when
   * a foe is near — foe proximity is Manhattan (cannon-INDEPENDENT, since the seal
   * threat is the imminent follow-up, not a free cannon right now). CLASSIC on (the
   * closed map is corridors and dies TRAPPED); PIRATE off (it dies to the shrink
   * wall, not a foe seal, so this would only veto useful bombs). false = v4 gate.
   */
  readonly corridorGate: boolean;
  /**
   * v5 FARMING CADENCE (per map). Two coupled tweaks to the FARMING bomb decision
   * (gated to: not pureHunt, no foe engaged — combat behaviour untouched):
   *  H1 no-waste:  a farming bomb that breaks 0 bricks AND hits no foe is dropped
   *      (downgraded to the best non-bomb action) — never spend a cannon on nothing.
   *  H2 pre-place: a PRODUCTIVE farming bomb (breaks >=1 brick, spare cannon free)
   *      BYPASSES the stochastic `bombChance` throttle, so the bot keeps bombs
   *      fusing back-to-back instead of randomly skipping ~45% of farm chances.
   * PIRATE on (the open map turns faster farming tempo straight into a lead: screen
   * paired +18.8% vs the trapper mirror, gate flat). CLASSIC off (the cramped
   * lattice punished it — searching/not-wasting bombs herds the bot into the
   * trapper's vChain seal: screen -15.6% vs trapper). false = committed behaviour.
   */
  readonly farmCadence: boolean;
}
