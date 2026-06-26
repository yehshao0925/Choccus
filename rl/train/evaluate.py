# rl/train/evaluate.py
"""
Evaluation harness: win rate vs random-safe opponent in Python sim.

Proxy gate used during development.
Ship gate uses TS bench: npm run v5-probe -- --target=rl:hunter --opponents=v6:hunter

Usage:
  rl/.venv/bin/python -m rl.train.evaluate rl/checkpoints/final_classic.zip \
    --episodes 200 --map classic
"""
import argparse
import numpy as np

from rl.env.choccus_env import ChoccusEnv


class MockModel:
    """Deterministic test policy — no SB3 dependency needed."""
    def __init__(self, always_action: int = 0):
        self._action = always_action

    def predict(self, obs, state=None, deterministic: bool = True):
        return np.array(self._action), None


def win_rate_vs_random(
    model,
    n_episodes: int = 100,
    map_kind: str = 'classic',
    max_steps: int = 12_000,
) -> float:
    """
    Evaluate model for n_episodes vs random-safe opponent.
    model must implement: predict(obs, state, deterministic) -> (action, new_state)
    Returns fraction of won episodes.
    """
    wins = 0
    for ep in range(n_episodes):
        env = ChoccusEnv(map_kind=map_kind, num_opponents=1)
        obs, _ = env.reset(seed=ep)
        lstm_state = None
        done = False
        last_reward = 0.0
        steps = 0

        while not done and steps < max_steps:
            action, lstm_state = model.predict(obs, state=lstm_state, deterministic=True)
            obs, last_reward, terminated, truncated, _ = env.step(int(action))
            done = terminated or truncated
            steps += 1

        if last_reward > 50.0:
            wins += 1

    rate = wins / n_episodes
    print(f"Win rate vs random-safe ({map_kind}): {rate:.2%} over {n_episodes} episodes")
    return rate


if __name__ == '__main__':
    from sb3_contrib import RecurrentPPO

    parser = argparse.ArgumentParser()
    parser.add_argument('model', help='Path to .zip checkpoint')
    parser.add_argument('--episodes', type=int, default=100)
    parser.add_argument('--map', default='classic')
    args = parser.parse_args()

    model = RecurrentPPO.load(args.model)
    win_rate_vs_random(model, args.episodes, args.map)
