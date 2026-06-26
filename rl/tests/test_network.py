# rl/tests/test_network.py
import torch
import numpy as np
import gymnasium as gym
from gymnasium import spaces
from rl.train.network import ChoccusCNNExtractor
from rl.env.constants import MAP_ROWS, MAP_COLS


def _obs_space():
    return spaces.Dict({
        'grid':    spaces.Box(-1.0, 1.0, (MAP_ROWS, MAP_COLS, 12), np.float32),
        'scalars': spaces.Box(-1.0, 1.0, (9,), np.float32),
    })


def test_extractor_output_shape():
    extractor = ChoccusCNNExtractor(_obs_space(), features_dim=512)
    batch = {
        'grid':    torch.zeros(4, MAP_ROWS, MAP_COLS, 12),
        'scalars': torch.zeros(4, 9),
    }
    out = extractor(batch)
    assert out.shape == (4, 512)


def test_extractor_no_nan():
    extractor = ChoccusCNNExtractor(_obs_space())
    batch = {
        'grid':    torch.rand(2, MAP_ROWS, MAP_COLS, 12),
        'scalars': torch.rand(2, 9),
    }
    out = extractor(batch)
    assert not torch.isnan(out).any()


def test_extractor_custom_features_dim():
    extractor = ChoccusCNNExtractor(_obs_space(), features_dim=256)
    batch = {
        'grid':    torch.zeros(1, MAP_ROWS, MAP_COLS, 12),
        'scalars': torch.zeros(1, 9),
    }
    out = extractor(batch)
    assert out.shape == (1, 256)
