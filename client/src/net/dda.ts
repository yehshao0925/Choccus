/**
 * Local dynamic difficulty adjustment (DDA) for filler bots — no accounts, no
 * server, no global ladder. It just remembers your recent results vs bots in
 * localStorage and nudges the suggested tier: win twice in a row → harder, lose
 * twice → easier. This pre-selects the "+ Bot" tier so the bot tracks your
 * level. When a real human rating ladder exists later, this gets replaced by
 * picking bots calibrated to your global score (see chat / docs).
 *
 * `nextDDA` is a pure reducer (unit-tested); the load/save wrappers are the
 * only impure part and degrade to defaults if localStorage is unavailable.
 */
import { BOT_TIERS, type BotTier } from '../ai/botDifficulty';

export interface DdaState {
  tier: BotTier;
  /** Signed streak: + = consecutive wins, − = consecutive losses. */
  streak: number;
}

const DEFAULT: DdaState = { tier: 'normal', streak: 0 };
const STORAGE_KEY = 'choccus.dda';
/** Consecutive same-result count that shifts the tier one rung. */
const SHIFT_AT = 2;

/**
 * Pure transition: fold one match result into the DDA state. A draw leaves the
 * state untouched; a win/loss extends (or flips) the streak, and SHIFT_AT in a
 * row moves the tier one rung and resets the streak.
 */
export function nextDDA(state: DdaState, result: 'win' | 'loss' | 'draw'): DdaState {
  if (result === 'draw') return state;
  const inc = result === 'win' ? 1 : -1;
  // Extend a same-sign streak; otherwise flip to a fresh streak of 1 in the new
  // direction (a win cancels a losing streak, and vice-versa).
  const streak = Math.sign(state.streak) === inc ? state.streak + inc : inc;
  const i = BOT_TIERS.indexOf(state.tier);
  if (streak >= SHIFT_AT && i < BOT_TIERS.length - 1) {
    return { tier: BOT_TIERS[i + 1]!, streak: 0 };
  }
  if (streak <= -SHIFT_AT && i > 0) {
    return { tier: BOT_TIERS[i - 1]!, streak: 0 };
  }
  return { tier: state.tier, streak };
}

function load(): DdaState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT;
    const p = JSON.parse(raw) as Partial<DdaState>;
    const tier = BOT_TIERS.includes(p.tier as BotTier) ? (p.tier as BotTier) : 'normal';
    const streak = typeof p.streak === 'number' ? p.streak : 0;
    return { tier, streak };
  } catch {
    return DEFAULT;
  }
}

/** The tier to pre-select in the lobby's "+ Bot" picker. */
export function suggestedTier(): BotTier {
  return load().tier;
}

/** Record a finished bot match and return the new suggested tier. */
export function recordBotResult(result: 'win' | 'loss' | 'draw'): BotTier {
  const next = nextDDA(load(), result);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — suggestion just won't persist */
  }
  return next.tier;
}
