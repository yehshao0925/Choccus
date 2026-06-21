/**
 * BotConfig — AI bot difficulty presets, humanization params, and a
 * bot-private deterministic RNG.
 *
 * Determinism discipline: NONE of the wall-clock / nondeterministic-random
 * globals. Bot randomness wraps Mulberry32 (see Prng.ts) and is threaded by the
 * caller — every `*Rand*` call returns `[value, newState]` and the new state
 * MUST be carried forward. This module deliberately keeps its own RNG state and
 * MUST NOT read `SimState.prng`, so bot decisions stay fully separate from the
 * simulation's RNG stream. (Math.imul is fine; only the nondeterministic
 * randomness source is banned.)
 */
import { prngFloat, prngInt } from '../../sim/Prng';

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface BotTuning {
  /** 對「新出現的威脅」延遲幾 tick 才反應（越大越像菜鳥、越容易被炸）。 */
  reactionDelayTicks: number;
  /** 每次決策有多少機率做出次佳/隨機選擇（0..1）。 */
  mistakeChance: number;
  /** 對目前計畫/方向至少維持幾 tick 再重新規劃（給移動慣性、避免抖動）。 */
  replanIntervalTicks: number;
  /** 放炸彈前要求逃生路線最長幾步以內才允許放（安全閥；越大越敢放）。 */
  maxEscapeLen: number;
  /** 遇到「可以放炸彈」的機會時，實際放下的機率（0..1，控制積極度）。 */
  bombChance: number;
  /**
   * 進攻權重旋鈕（連續、0..2 左右）。餵進 aggressionWeight()：越大 → 進攻項
   * (enemyPressure) 的權重越高，行為從保守往激進連續滑動。沒有「模式切換」——
   * 進攻/防守是分數權重的湧現結果。easy 低、normal 中、hard 高。
   * Optional so the FROZEN baseline tunings (which predate this knob) stay
   * type-clean; the live scoring bot defaults a missing value to 1.0 (neutral).
   */
  aggression?: number;
  /**
   * 在「失誤」分支裡，這次失誤改成「無逃生路線仍硬放炸彈」（會送命）的機率
   * （0..1）。normal/hard 一律 0：失誤只會走次佳方向，絕不自爆；只有 easy
   * 保留極低機率模擬菜鳥亂放。
   */
  recklessBombChance: number;
  /** 亂V：連鎖放置幾顆炸彈形成 V/之字封路（undefined/0 = 今日的單顆行為）。 */
  vChainBombs?: number;
  /** 亂V：在符合連鎖條件時，實際續放下一顆的機率（0..1；undefined 視為 1）。 */
  vChainChance?: number;
  /** 亂V：只有當敵人在這麼多格曼哈頓距離內才啟動連鎖（undefined 視為不限制 / 一個合理預設如 4）。 */
  vChainFoeRange?: number;
  /** 模式門檻：敵人在這麼多格曼哈頓距離內就切到對戰模式，否則維持「清軟格農場」模式（undefined 視為合理預設 5）。 */
  combatRangeTiles?: number;

  // --- v3 ROSTER archetype behaviour flags (deliberately non-transitive set) ---
  // Each switches a distinct behaviour AXIS on top of the shared scoring core so
  // the archetypes occupy genuinely different corners (the matrix, not a scalar,
  // reveals the rock-paper-scissors structure). All optional → undefined = the
  // neutral scoring bot. Pure / deterministic (no new RNG except `noise`, which
  // uses the threaded bot RNG).
  /** 獵殺流 Hunter：永遠朝對手逼近、不農田不撿道具、放寬保命換 tempo（接受高風險）。 */
  pureHunt?: boolean;
  /** 逃跑流 Runner：永遠走離對手最遠的安全格、幾乎不放彈（純存活，靠耗死魯莽方）。 */
  fleeFoe?: boolean;
  /** 控場流 Zoner：與對手保持這個距離的「環」，從環上用炸彈壓縮對手空間、佔中心、把對手往角落趕，不近身（0/undefined = 關閉）。 */
  zoneStandoff?: number;
  /** 反應流 Reactive：鏡像/反制對手上一個動作（影子跟隨 + 對手放彈就封其逃生），自己不主導節奏；仍過保命安全網。 */
  mirror?: boolean;
  /** 隨機擾動 Noise：池外裁判——加權隨機合法動作，只保留「不主動自殺」的最低理性（強度地板 / 抗過擬合偵測）。 */
  noise?: boolean;
}

export const DIFFICULTY_PRESETS: Readonly<Record<Difficulty, BotTuning>> =
  Object.freeze({
    easy: Object.freeze({
      reactionDelayTicks: 21, // 21 ticks ≈ 350 ms (×1000/60)
      mistakeChance: 0.3,
      replanIntervalTicks: 30,
      // Shorter routes only: an easy bot moves at base speed, so a 3-tile dash
      // (~36 ticks) comfortably fits the 180-tick fuse with its slow reaction.
      maxEscapeLen: 3,
      bombChance: 0.3,
      aggression: 0.6, // easy: timid — survivability dominates, weak attack pull.
      // ~5% of mistakes (≈1.5% of decisions) become a reckless self-bomb —
      // keeps easy bots feeling fallible without dominating the death log.
      recklessBombChance: 0.05,
      combatRangeTiles: 4, // easy: only engage foes that are nearly adjacent.
    }),
    normal: Object.freeze({
      reactionDelayTicks: 10, // 10 ticks ≈ 167 ms (×1000/60)
      mistakeChance: 0.12,
      replanIntervalTicks: 18,
      // 4 tiles ≈ 48 ticks travel + reaction + cushion < 180-tick fuse.
      maxEscapeLen: 4,
      bombChance: 0.55,
      aggression: 1.0, // normal: balanced attack pull.
      recklessBombChance: 0, // normal never blind-bombs itself.
      combatRangeTiles: 5, // normal: engage foes within ~5 tiles.
    }),
    hard: Object.freeze({
      reactionDelayTicks: 3, // 3 ticks ≈ 50 ms (×1000/60)
      mistakeChance: 0.03,
      replanIntervalTicks: 8,
      // 5 tiles ≈ 60 ticks travel + tiny reaction + cushion < 180-tick fuse.
      maxEscapeLen: 5,
      bombChance: 0.85,
      aggression: 1.5, // hard: strong attack pull (still gated by survivability).
      recklessBombChance: 0, // hard never blind-bombs itself.
      combatRangeTiles: 7, // hard: engage from further out (more aggressive).
    }),
  });

/** Resolve a tuning, falling back to `normal` for any unknown difficulty. */
export function tuningFor(d: Difficulty): BotTuning {
  return Object.prototype.hasOwnProperty.call(DIFFICULTY_PRESETS, d)
    ? DIFFICULTY_PRESETS[d]
    : DIFFICULTY_PRESETS.normal;
}

/** Parse a difficulty string (any case / whitespace), defaulting to `normal`. */
export function parseDifficulty(s: string | null): Difficulty {
  if (s === null) return 'normal';
  const v = s.toLowerCase().trim();
  if (v === 'easy' || v === 'normal' || v === 'hard') return v;
  return 'normal';
}

/**
 * Derive a per-slot bot RNG seed from the match seed. Pure integer mix
 * (Math.imul + xor + shifts with golden-ratio-ish odd constants), finished
 * with `>>> 0` so the result is a uint32. Distinct slots yield distinct seeds.
 */
export function botSeed(matchSeed: number, slot: number): number {
  let h = matchSeed >>> 0;
  h = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (slot * 0x27d4eb2f + 0x165667b1), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Bot-private uniform float in [0, 1). Returns `[value, newState]`. */
export function botRandFloat(state: number): [number, number] {
  return prngFloat(state);
}

/** Bot-private uniform integer in [min, maxIncl]. Returns `[value, newState]`. */
export function botRandInt(
  state: number,
  min: number,
  maxIncl: number,
): [number, number] {
  return prngInt(state, min, maxIncl);
}
