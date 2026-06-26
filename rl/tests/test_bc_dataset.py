# rl/tests/test_bc_dataset.py
import json
import os
import tempfile
import numpy as np
import torch
from rl.train.bc_dataset import BCDataset, replay_trajectory


def _dummy_entry(seed=0, ticks=50):
    return {
        'seed': seed,
        'map_kind': 'classic',
        'num_players': 2,
        'ticks': [[0, 0]] * ticks,
    }


def test_replay_trajectory_returns_samples():
    entry = _dummy_entry(seed=0, ticks=100)
    samples = replay_trajectory(entry)
    assert len(samples) == 100
    grid, scalars, action = samples[0]
    assert grid.shape == (13, 15, 12)
    assert grid.dtype == np.float32
    assert scalars.shape == (9,)
    assert scalars.dtype == np.float32
    assert isinstance(action, int)
    assert 0 <= action <= 5


def test_replay_terminates_early_on_game_over():
    entry = _dummy_entry(seed=1, ticks=200)
    samples = replay_trajectory(entry)
    assert len(samples) <= 200
    assert len(samples) > 0


def test_dataset_length_and_item_types():
    entry = _dummy_entry(seed=0, ticks=30)
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
        f.write(json.dumps(entry) + '\n')
        f.write(json.dumps(_dummy_entry(seed=1, ticks=20)) + '\n')
        fname = f.name
    try:
        ds = BCDataset(fname)
        assert len(ds) > 0
        grid, scalars, action = ds[0]
        assert isinstance(grid, torch.Tensor)
        assert grid.shape == (13, 15, 12)
        assert isinstance(scalars, torch.Tensor)
        assert scalars.shape == (9,)
        assert isinstance(action, torch.Tensor)
        assert action.dtype == torch.long
    finally:
        os.unlink(fname)


def test_dataset_action_values_in_range():
    entry = _dummy_entry(seed=0, ticks=50)
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
        f.write(json.dumps(entry) + '\n')
        fname = f.name
    try:
        ds = BCDataset(fname)
        for _, _, action in ds:
            assert 0 <= int(action) <= 5
    finally:
        os.unlink(fname)
