/**
 * Match outcome resolution — pure, deterministic (no RNG, no wall-clock).
 *
 * One source of truth for "who won?" the moment the sim reaches OVER, shared by
 * every consumer that must name a winner: the net match-runner, the solo HUD
 * banner, and the spectate scoreboard. Living in the sim layer means the SAME
 * rule runs on every client (net determinism) and collapses the tiebreak logic
 * that was previously copy-pasted into spectate / the benches.
 *
 * Resolution order (the PvP timeout rule):
 *   1. Most survivors — the team with the most alive players wins.
 *   2. Tie on survivor count → item-progress tiebreak (pickups, then fire, then
 *      cannon), comparing each tied team's strongest alive player.
 *   3. Still fully tied (or nobody alive) → draw.
 * A clean last-team-standing finish is just the single-surviving-team case.
 */
import {
  PLAYER_START_CANNON,
  PLAYER_START_FIRE,
  PLAYER_START_SPEED_BONUS,
} from '../../../shared/constants';
import { type PlayerState } from './Player';
import { type SimState } from './Sim';

/**
 * Item-progress score = number of pickups collected (fire + cannon + speed).
 * Each fire/cannon item is +1 to its stat; each speed item is +4 tenths, so
 * dividing the speed bonus by 4 recovers the speed-item count. Pure integer.
 */
export function itemScore(p: PlayerState): number {
  return (
    (p.fire - PLAYER_START_FIRE) +
    (p.cannon - PLAYER_START_CANNON) +
    Math.trunc((p.speedBonusTenths - PLAYER_START_SPEED_BONUS) / 4)
  );
}

/** Tiebreak key for one player: [itemScore, fire, cannon] — higher is better. */
function playerKey(p: PlayerState): [number, number, number] {
  return [itemScore(p), p.fire, p.cannon];
}

/** Compare two slots' keys DESC (higher first); slot index breaks a full tie. */
function compareSlotsDesc(state: SimState, a: number, b: number): number {
  const ka = playerKey(state.players[a]!);
  const kb = playerKey(state.players[b]!);
  for (let i = 0; i < ka.length; i++) if (ka[i]! !== kb[i]!) return kb[i]! - ka[i]!;
  return a - b; // stable: lower slot first (reached only on an exact stat tie)
}

export interface MatchOutcome {
  /** Winning team id, or null for a genuine draw. */
  winnerTeam: number | null;
  /** Representative winning slot (the strongest alive player on the winning
   *  team), or null for a draw — lets a per-slot scoreboard credit the right
   *  contestant. */
  winnerSlot: number | null;
}

const DRAW: MatchOutcome = { winnerTeam: null, winnerSlot: null };

/**
 * Resolve the winner of a state (normally an OVER state) under the rule above.
 * Handles both the natural last-team-standing end and a tick-cap timeout with
 * multiple teams still alive. Deterministic: a pure function of the players'
 * alive / team / stat fields with slot index as the final stable tiebreak.
 */
export function resolveOutcome(state: SimState): MatchOutcome {
  // Alive slots grouped by team (ascending slot order preserved within a team).
  const aliveByTeam = new Map<number, number[]>();
  for (let s = 0; s < state.players.length; s++) {
    const p = state.players[s]!;
    if (!p.alive) continue;
    const slots = aliveByTeam.get(p.team);
    if (slots === undefined) aliveByTeam.set(p.team, [s]);
    else slots.push(s);
  }
  if (aliveByTeam.size === 0) return DRAW;

  // (1) Most survivors. Represent each tied team by its strongest alive player.
  let maxAlive = 0;
  for (const slots of aliveByTeam.values()) {
    if (slots.length > maxAlive) maxAlive = slots.length;
  }
  const reps: { team: number; slot: number }[] = [];
  for (const [team, slots] of aliveByTeam) {
    if (slots.length !== maxAlive) continue;
    const best = slots.slice().sort((a, b) => compareSlotsDesc(state, a, b))[0]!;
    reps.push({ team, slot: best });
  }

  // A single team owns the most survivors → it wins outright (covers the clean
  // last-team-standing finish, where it is the only alive team).
  if (reps.length === 1) return { winnerTeam: reps[0]!.team, winnerSlot: reps[0]!.slot };

  // (2) Item tiebreak between the tied teams' champions; team id is the final
  // deterministic key for ordering before we decide a draw.
  reps.sort((x, y) => compareSlotsDesc(state, x.slot, y.slot) || x.team - y.team);
  const top = reps[0]!;
  const second = reps[1]!;
  const kt = playerKey(state.players[top.slot]!);
  const ks = playerKey(state.players[second.slot]!);
  // (3) The two best teams tie on every stat → genuine draw.
  if (kt.every((v, i) => v === ks[i]!)) return DRAW;
  return { winnerTeam: top.team, winnerSlot: top.slot };
}
