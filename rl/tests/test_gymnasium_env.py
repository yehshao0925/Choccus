# rl/tests/test_gymnasium_env.py
import numpy as np
import pytest
import gymnasium as gym
from rl.env.choccus_env import ChoccusEnv
from rl.env.constants import MAP_ROWS, MAP_COLS


def test_env_creation():
    env = ChoccusEnv(map_kind='classic', num_opponents=1)
    assert env is not None


def test_reset_returns_valid_obs():
    env = ChoccusEnv(map_kind='classic', num_opponents=1)
    obs, info = env.reset(seed=0)
    assert 'grid' in obs
    assert 'scalars' in obs
    assert obs['grid'].shape == (MAP_ROWS, MAP_COLS, 12)
    assert obs['scalars'].shape == (9,)


def test_step_returns_tuple():
    env = ChoccusEnv(map_kind='classic', num_opponents=1)
    env.reset(seed=0)
    obs, reward, terminated, truncated, info = env.step(0)  # action=stay
    assert isinstance(reward, float)
    assert isinstance(terminated, bool)
    assert isinstance(truncated, bool)


def test_action_mask_in_info():
    env = ChoccusEnv(map_kind='classic', num_opponents=1)
    env.reset(seed=0)
    _, _, _, _, info = env.step(0)
    assert 'action_mask' in info
    assert info['action_mask'].shape == (6,)


def test_env_terminates():
    env = ChoccusEnv(map_kind='classic', num_opponents=1)
    env.reset(seed=0)
    done = False
    steps = 0
    while not done and steps < 15000:
        _, _, terminated, truncated, _ = env.step(env.action_space.sample())
        done = terminated or truncated
        steps += 1
    assert done, f"Game did not terminate after {steps} steps"


def test_observation_space_valid():
    env = ChoccusEnv(map_kind='classic', num_opponents=1)
    obs, _ = env.reset(seed=0)
    assert env.observation_space['grid'].contains(obs['grid'])
    assert env.observation_space['scalars'].contains(obs['scalars'])
