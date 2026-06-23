"""Authoritative player ratings — OpenSkill (PlackettLuce) over SQLite.

The relay is the only place that updates ratings: clients merely report the
match winner (cross-checked by lockstep hash agreement), and this module
recomputes μ/σ for every participant and persists them. Open-source and
patent-free (unlike TrueSkill), so it fits the clean-room rules.

Bots get NO special treatment — they are stored under a stable synthetic id
(``bot:<tier>``) and rated like any other player, so co-play places them on the
same scale as humans (see chat: "bots as normal players").

Storage is a single table; SQLite is plenty for one relay process. The default
rating is μ=25, σ=25/3 ≈ 8.333; the displayed/leaderboard score is the
conservative ordinal μ − 3σ (≈0 for a brand-new player).
"""

import sqlite3
import time
from collections.abc import Iterable

from openskill.models import PlackettLuce

DEFAULT_MU = 25.0
DEFAULT_SIGMA = 25.0 / 3.0


def synthetic_bot_id(tier: str) -> str:
    """Stable rating id shared by every bot of a tier (it's one fixed agent)."""
    return f"bot:{tier}"


def ordinal(mu: float, sigma: float) -> float:
    """Conservative display score (μ − 3σ); matches OpenSkill's ordinal()."""
    return mu - 3.0 * sigma


class RatingStore:
    def __init__(self, db_path: str = ":memory:") -> None:
        self._db = sqlite3.connect(db_path)
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS ratings (
                 player_id  TEXT PRIMARY KEY,
                 name       TEXT,
                 mu         REAL NOT NULL,
                 sigma      REAL NOT NULL,
                 games      INTEGER NOT NULL DEFAULT 0,
                 updated_at REAL NOT NULL
               )"""
        )
        self._db.commit()
        self._model = PlackettLuce()

    # -- reads ----------------------------------------------------------------

    def get(self, player_id: str) -> tuple[float, float]:
        """(μ, σ) for a player; the default rating if never seen."""
        row = self._db.execute(
            "SELECT mu, sigma FROM ratings WHERE player_id = ?", (player_id,)
        ).fetchone()
        return (row[0], row[1]) if row is not None else (DEFAULT_MU, DEFAULT_SIGMA)

    def scores(self, player_ids: Iterable[str]) -> dict[str, float]:
        """Display score (μ − 3σ) per id, for roster display."""
        return {pid: ordinal(*self.get(pid)) for pid in player_ids}

    # -- writes ---------------------------------------------------------------

    def apply_match(
        self, participants: list[dict], winner_team: int | None
    ) -> dict[str, float]:
        """Recompute + persist ratings for one finished match.

        participants: [{"player_id", "name", "team"}].
        winner_team:  the winning team id, or None for a draw (all teams tie).
        Returns the new display score per player_id. A match with fewer than two
        distinct teams is a no-op (nothing to compare).
        """
        teams = sorted({p["team"] for p in participants})
        if len(teams) < 2:
            return {}

        grouped = [[p for p in participants if p["team"] == t] for t in teams]
        os_teams = [
            [
                self._model.rating(mu=mu, sigma=sigma, name=p["player_id"])
                for p in group
                for mu, sigma in [self.get(p["player_id"])]
            ]
            for group in grouped
        ]
        # Lower rank = better. Winner → 0, everyone else → 1; a draw ranks all 0.
        ranks = [
            0 if winner_team is None or t == winner_team else 1 for t in teams
        ]
        rated = self._model.rate(os_teams, ranks=ranks)

        now = time.time()
        out: dict[str, float] = {}
        for group, new_team in zip(grouped, rated):
            for p, r in zip(group, new_team):
                self._upsert(p["player_id"], p.get("name", ""), r.mu, r.sigma, now)
                out[p["player_id"]] = ordinal(r.mu, r.sigma)
        self._db.commit()
        return out

    def _upsert(
        self, player_id: str, name: str, mu: float, sigma: float, now: float
    ) -> None:
        self._db.execute(
            """INSERT INTO ratings (player_id, name, mu, sigma, games, updated_at)
                 VALUES (?, ?, ?, ?, 1, ?)
               ON CONFLICT(player_id) DO UPDATE SET
                 name=excluded.name, mu=excluded.mu, sigma=excluded.sigma,
                 games=ratings.games + 1, updated_at=excluded.updated_at""",
            (player_id, name, mu, sigma, now),
        )

    def close(self) -> None:
        self._db.close()
