# rl/tests/test_bc_dataset.py
import itertools
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


def _write_jsonl(entries) -> str:
    f = tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False)
    for e in entries:
        f.write(json.dumps(e) + '\n')
    f.close()
    return f.name


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


def test_dataset_yields_tensors():
    path = _write_jsonl([_dummy_entry(seed=0, ticks=30), _dummy_entry(seed=1, ticks=20)])
    try:
        ds = BCDataset(path, shuffle_buffer=0)
        samples = list(itertools.islice(ds, 5))
        assert len(samples) == 5
        grid, scalars, action = samples[0]
        assert isinstance(grid, torch.Tensor)
        assert grid.shape == (13, 15, 12)
        assert isinstance(scalars, torch.Tensor)
        assert scalars.shape == (9,)
        assert isinstance(action, torch.Tensor)
        assert action.dtype == torch.long
    finally:
        os.unlink(path)


def test_dataset_action_values_in_range():
    path = _write_jsonl([_dummy_entry(seed=0, ticks=50)])
    try:
        ds = BCDataset(path, shuffle_buffer=0)
        for _, _, action in ds:
            assert 0 <= int(action) <= 5
    finally:
        os.unlink(path)


def test_dataset_max_games():
    # 2 games × 10 ticks; both players stay (no bombs), so neither dies.
    # replay_trajectory yields exactly 10 samples per game.
    path = _write_jsonl([_dummy_entry(seed=i, ticks=10) for i in range(5)])
    try:
        ds = BCDataset(path, max_games=2, shuffle_buffer=0)
        total = sum(1 for _ in ds)
        assert total == 20
    finally:
        os.unlink(path)


def test_dataset_shuffle_buffer_zero_is_deterministic():
    path = _write_jsonl([_dummy_entry(seed=0, ticks=30)])
    try:
        ds = BCDataset(path, shuffle_buffer=0)
        run1 = [int(a) for _, _, a in ds]
        run2 = [int(a) for _, _, a in ds]
        assert run1 == run2
    finally:
        os.unlink(path)
