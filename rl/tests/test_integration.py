# rl/tests/test_integration.py
"""
End-to-end: environment runs 100 episodes without crash;
reward is finite; observations stay in bounds.
"""
import numpy as np
import pytest
from rl.env.choccus_env import ChoccusEnv


def test_100_episodes_stable():
    env = ChoccusEnv(map_kind='classic', num_opponents=1)
    for ep in range(100):
        obs, _ = env.reset(seed=ep)
        done = False
        steps = 0
        while not done and steps < 12000:
            action = env.action_space.sample()
            obs, reward, term, trunc, info = env.step(action)
            assert np.isfinite(reward), f"episode {ep} step {steps}: non-finite reward {reward}"
            assert obs['grid'].min() >= -1.0 and obs['grid'].max() <= 1.0
            assert obs['scalars'].min() >= -1.0 and obs['scalars'].max() <= 1.0
            done = term or trunc
            steps += 1
        assert done, f"Episode {ep} did not terminate in {steps} steps"


def test_pirate_map_runs():
    env = ChoccusEnv(map_kind='pirate', num_opponents=1)
    obs, _ = env.reset(seed=0)
    for _ in range(100):
        obs, reward, term, trunc, _ = env.step(0)
        if term or trunc:
            break
