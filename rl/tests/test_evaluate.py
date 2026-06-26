# rl/tests/test_evaluate.py
import numpy as np
from rl.train.evaluate import win_rate_vs_random, MockModel


def test_mock_model_win_rate_in_range():
    model = MockModel(always_action=0)
    rate = win_rate_vs_random(model, n_episodes=5, map_kind='classic')
    assert 0.0 <= rate <= 1.0


def test_win_rate_pirate_map():
    model = MockModel(always_action=1)
    rate = win_rate_vs_random(model, n_episodes=5, map_kind='pirate')
    assert 0.0 <= rate <= 1.0


def test_win_rate_terminates_all_episodes():
    model = MockModel(always_action=0)
    rate = win_rate_vs_random(model, n_episodes=3, map_kind='classic', max_steps=12000)
    assert isinstance(rate, float)
