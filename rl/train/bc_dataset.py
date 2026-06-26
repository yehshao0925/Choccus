# rl/train/bc_dataset.py
"""
BCDataset: replays v6:hunter trajectory JSONL using Python sim and
encodes each tick as (grid, scalars, action) for BC supervised training.
"""
import json
from pathlib import Path
import numpy as np
import torch
from torch.utils.data import Dataset

from rl.env.sim import create_initial_state, tick as sim_tick
from rl.env.state_encoder import encode_state
from rl.env.types import (
    DIR_NONE, DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT,
    ACTION_BOMB, InputFrame, PHASE_PLAYING,
)

_IDX_TO_INPUT = [
    InputFrame(dir=DIR_NONE,  action=0),
    InputFrame(dir=DIR_UP,    action=0),
    InputFrame(dir=DIR_DOWN,  action=0),
    InputFrame(dir=DIR_LEFT,  action=0),
    InputFrame(dir=DIR_RIGHT, action=0),
    InputFrame(dir=DIR_NONE,  action=ACTION_BOMB),
]


def replay_trajectory(entry: dict) -> list[tuple[np.ndarray, np.ndarray, int]]:
    state = create_initial_state(
        seed=entry['seed'],
        map_kind=entry['map_kind'],
        num_players=entry['num_players'],
    )
    samples: list[tuple[np.ndarray, np.ndarray, int]] = []
    for tick_actions in entry['ticks']:
        if state['phase'] != PHASE_PLAYING:
            break
        grid, scalars = encode_state(state, slot=0)
        action_idx = tick_actions[0]
        samples.append((grid, scalars, int(action_idx)))
        inputs = [_IDX_TO_INPUT[a] for a in tick_actions]
        state = sim_tick(state, inputs)
    return samples


class BCDataset(Dataset):
    def __init__(self, jsonl_path: str):
        self._grids:   list[np.ndarray] = []
        self._scalars: list[np.ndarray] = []
        self._actions: list[int] = []

        with open(jsonl_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                entry = json.loads(line)
                for grid, scalars, action in replay_trajectory(entry):
                    self._grids.append(grid)
                    self._scalars.append(scalars)
                    self._actions.append(action)

    def __len__(self) -> int:
        return len(self._actions)

    def __getitem__(self, idx: int):
        return (
            torch.from_numpy(self._grids[idx]),
            torch.from_numpy(self._scalars[idx]),
            torch.tensor(self._actions[idx], dtype=torch.long),
        )
