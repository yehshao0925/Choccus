/**
 * Player rating via OpenSkill (open-source, patent-free Weng-Lin / Bayesian
 * team rating — the clean-room-safe TrueSkill alternative; MIT). This module is
 * PURE: outcome in → new ratings out. It does not persist anything and is not
 * yet wired into the live match flow — identity + storage (where μ/σ live, who
 * owns a rating) is the next decision. Bots get NO special handling: enrol them
 * as ordinary players with the default rating and let co-play place them on the
 * same scale (see chat — "bots as normal players" is the lazy, correct default).
 *
 * Convention:
 *   - internal rating  = { mu, sigma } (defaults μ=25, σ=25/3 ≈ 8.333)
 *   - displayed score  = ordinal = μ − 3σ (new player shows ~0, rises with games)
 *   - rank: lower = better; equal ranks = a draw between those teams.
 */
import { ordinal, rate, rating } from 'openskill';

export interface PlayerRating {
  mu: number;
  sigma: number;
}

/** A participant in one match: stable id, their team, and current rating. */
export interface RatedPlayer {
  id: string;
  team: number;
  rating: PlayerRating;
}

/** Fresh rating for a never-seen player (μ=25, σ≈8.333). */
export function defaultRating(): PlayerRating {
  return rating();
}

/** Leaderboard/matchmaking number: μ − 3σ (conservative; ~0 for a new player). */
export function displayScore(r: PlayerRating): number {
  return ordinal(r);
}

/**
 * Update teams given their finishing ranks (lower = better; equal = draw).
 * `teams[i]` is one team's player ratings; the returned array mirrors that
 * shape and order. Throws nothing — fewer than two teams is a no-op.
 */
export function rateMatch(
  teams: PlayerRating[][],
  ranks: number[],
): PlayerRating[][] {
  if (teams.length < 2) return teams.map((t) => t.map((p) => ({ ...p })));
  const result = rate(
    teams.map((t) => t.map((p) => rating(p))),
    { rank: ranks },
  );
  return result.map((t) => t.map((p) => ({ mu: p.mu, sigma: p.sigma })));
}

/**
 * Choccus-facing helper: fold a finished match into new ratings, keyed by
 * player id. `winnerTeam === null` (time-cap draw / mutual KO) ranks every team
 * equal. Players are grouped by team in ascending team order; the winning team
 * ranks 1st and every other team ties for 2nd (the sim only reports the last
 * team standing, not full placement — refine with elimination order later).
 */
export function rateOutcome(
  players: RatedPlayer[],
  winnerTeam: number | null,
): Map<string, PlayerRating> {
  const teamIds = [...new Set(players.map((p) => p.team))].sort((a, b) => a - b);
  const grouped = teamIds.map((t) => players.filter((p) => p.team === t));
  const ranks = teamIds.map((t) =>
    winnerTeam === null ? 1 : t === winnerTeam ? 1 : 2,
  );

  const updated = rateMatch(
    grouped.map((g) => g.map((p) => p.rating)),
    ranks,
  );

  const out = new Map<string, PlayerRating>();
  grouped.forEach((g, i) => {
    g.forEach((p, j) => out.set(p.id, updated[i]![j]!));
  });
  return out;
}
