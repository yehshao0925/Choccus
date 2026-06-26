# rl/train/self_play.py
"""
Elo-rated checkpoint pool for self-play curriculum.

Workflow:
  1. After every checkpoint_freq steps, pool.add(path, elo=current_estimate)
  2. opp_path = pool.sample(current_elo=model_elo)
  3. Load opp_path as opponent policy in env
  4. After evaluation: pool.update(ckpt_path, opp_path, score)
"""
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path


def elo_expected(rating_a: float, rating_b: float) -> float:
    return 1.0 / (1.0 + 10.0 ** ((rating_b - rating_a) / 400.0))


def elo_update(
    rating_a: float,
    rating_b: float,
    score: float,
    k: float = 32.0,
) -> tuple[float, float]:
    """Return (new_a, new_b). score: 1.0=A wins, 0.5=draw, 0.0=B wins. Zero-sum."""
    exp_a = elo_expected(rating_a, rating_b)
    delta = k * (score - exp_a)
    return rating_a + delta, rating_b - delta


@dataclass
class PoolEntry:
    path:         str
    elo:          float = 1500.0
    games_played: int   = 0


class CheckpointPool:
    def __init__(self, max_size: int = 8, k_factor: float = 32.0):
        self.max_size = max_size
        self.k_factor = k_factor
        self.entries: list[PoolEntry] = []

    def add(self, path: str, elo: float = 1500.0):
        """Add checkpoint; evict lowest-Elo existing entry if at capacity."""
        self.entries.append(PoolEntry(path=path, elo=elo))
        if len(self.entries) > self.max_size:
            worst_idx = min(
                range(len(self.entries) - 1),
                key=lambda i: self.entries[i].elo,
            )
            self.entries.pop(worst_idx)

    def sample(self, current_elo: float = 1500.0, temperature: float = 1.0) -> str:
        """Sample opponent path weighted by Elo proximity."""
        if not self.entries:
            raise ValueError("Pool is empty")
        weights = [
            math.exp(-abs(e.elo - current_elo) / (400.0 * temperature))
            for e in self.entries
        ]
        total = sum(weights)
        probs = [w / total for w in weights]
        r = random.random()
        cumulative = 0.0
        for entry, p in zip(self.entries, probs):
            cumulative += p
            if r <= cumulative:
                return entry.path
        return self.entries[-1].path

    def update(self, player_path: str, opponent_path: str, score: float):
        """Update Elo ratings. score: 1.0=player won, 0.5=draw, 0.0=lost."""
        player   = next((e for e in self.entries if e.path == player_path),  None)
        opponent = next((e for e in self.entries if e.path == opponent_path), None)
        if player is None or opponent is None:
            return
        new_p, new_o = elo_update(player.elo, opponent.elo, score, self.k_factor)
        player.elo   = new_p
        opponent.elo = new_o
        player.games_played   += 1
        opponent.games_played += 1

    def best(self) -> PoolEntry | None:
        if not self.entries:
            return None
        return max(self.entries, key=lambda e: e.elo)

    def save(self, index_path: str):
        Path(index_path).parent.mkdir(parents=True, exist_ok=True)
        data = [{'path': e.path, 'elo': e.elo, 'games': e.games_played} for e in self.entries]
        with open(index_path, 'w') as f:
            json.dump({'pool': data, 'max_size': self.max_size}, f, indent=2)

    @classmethod
    def load(cls, index_path: str) -> 'CheckpointPool':
        with open(index_path) as f:
            data = json.load(f)
        pool = cls(max_size=data.get('max_size', 8))
        for item in data.get('pool', []):
            pool.entries.append(PoolEntry(
                path=item['path'], elo=item['elo'], games_played=item.get('games', 0)
            ))
        return pool
