# rl/train/bc_dataset.py
"""
BCDataset: streaming IterableDataset that replays v6:hunter trajectory JSONL
using Python sim and yields (grid, scalars, action) tuples for BC training.
Memory footprint is O(shuffle_buffer) samples, not O(dataset size).
"""
import json
import random
from collections.abc import Iterator

import numpy as np
import torch
from torch import Tensor
from torch.utils.data import IterableDataset

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


class BCDataset(IterableDataset):
    """
    Streaming BC dataset. Replays JSONL games one at a time and yields
    (grid, scalars, action) tensors via an in-memory shuffle buffer.

    Args:
        jsonl_path: path to JSONL file (one game per line)
        max_games: stop after this many games; None = all games
        shuffle_buffer: samples held in memory before shuffling and yielding;
                        0 = no shuffle (deterministic order, useful for tests)
    """

    def __init__(
        self,
        jsonl_path: str,
        max_games: int | None = None,
        shuffle_buffer: int = 5_000,
    ):
        self._path = jsonl_path
        self._max_games = max_games
        self._shuffle_buffer = shuffle_buffer

    def __iter__(self) -> Iterator[tuple[Tensor, Tensor, Tensor]]:
        buffer: list[tuple[Tensor, Tensor, Tensor]] = []
        games_read = 0

        with open(self._path) as f:
            for line in f:
                if self._max_games is not None and games_read >= self._max_games:
                    break
                line = line.strip()
                if not line:
                    continue
                entry = json.loads(line)
                for grid, scalars, action in replay_trajectory(entry):
                    buffer.append((
                        torch.from_numpy(grid.copy()),
                        torch.from_numpy(scalars.copy()),
                        torch.tensor(action, dtype=torch.long),
                    ))
                    if self._shuffle_buffer > 0 and len(buffer) >= self._shuffle_buffer:
                        random.shuffle(buffer)
                        yield from buffer
                        buffer = []
                games_read += 1

        if buffer:
            if self._shuffle_buffer > 0:
                random.shuffle(buffer)
            yield from buffer
