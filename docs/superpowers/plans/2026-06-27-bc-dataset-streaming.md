# BCDataset Streaming Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `BCDataset` from a fully-materialized `Dataset` to a streaming `IterableDataset` with an in-memory shuffle buffer and `max_games` cap, eliminating OOM on WSL2 7.8 GB machines.

**Architecture:** `BCDataset` changes base class to `IterableDataset`; `__init__` stores only config; `__iter__` replays games one by one, fills a shuffle buffer, and yields tuples. `bc_train.py` changes `shuffle=True` → `shuffle=False` since the buffer handles shuffling. Tests are rewritten to use iteration patterns instead of `__len__` / `__getitem__`.

**Tech Stack:** Python 3.12, PyTorch `IterableDataset`, existing `replay_trajectory` function (unchanged).

## Global Constraints

- All commands run from repo root `/home/m2553/repo/10-choccus`
- Python interpreter: `rl/.venv/bin/python`
- Test runner: `rl/.venv/bin/python -m pytest rl/tests/ -q`
- `replay_trajectory` function signature and behaviour must not change
- `num_workers=0` in DataLoader — multi-worker sharding is out of scope

---

## File Map

| File | Change |
|------|--------|
| `rl/train/bc_dataset.py` | Rewrite `BCDataset` class; `replay_trajectory` stays byte-identical |
| `rl/tests/test_bc_dataset.py` | Rewrite two tests; add two new tests; keep two `replay_trajectory` tests unchanged |
| `rl/train/bc_train.py` | One-line change: `shuffle=True` → `shuffle=False` |

---

### Task 1: Refactor BCDataset to IterableDataset

**Files:**
- Modify: `rl/train/bc_dataset.py`
- Modify: `rl/tests/test_bc_dataset.py`

**Interfaces:**
- Produces: `BCDataset(jsonl_path, max_games=None, shuffle_buffer=5000)` — `IterableDataset`, iterable, no `__len__`, no `__getitem__`
- Consumes: `replay_trajectory(entry) -> list[tuple[ndarray, ndarray, int]]` — unchanged

- [ ] **Step 1: Rewrite the tests first (they will fail against the old Dataset)**

Replace the entire content of `rl/tests/test_bc_dataset.py` with:

```python
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
```

- [ ] **Step 2: Run tests — confirm they fail against old code**

```bash
rl/.venv/bin/python -m pytest rl/tests/test_bc_dataset.py -v
```

Expected failures:
- `test_dataset_yields_tensors` — `TypeError: object of type 'BCDataset' has no len()` or `AttributeError`
- `test_dataset_max_games` — same
- `test_dataset_shuffle_buffer_zero_is_deterministic` — same
- The two `replay_trajectory` tests should still PASS

- [ ] **Step 3: Rewrite BCDataset in `rl/train/bc_dataset.py`**

Replace the entire file with:

```python
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
```

- [ ] **Step 4: Run tests — all 6 bc_dataset tests must pass**

```bash
rl/.venv/bin/python -m pytest rl/tests/test_bc_dataset.py -v
```

Expected: 6 PASSED

- [ ] **Step 5: Run full suite to catch any regressions**

```bash
rl/.venv/bin/python -m pytest rl/tests/ -q
```

Expected: all previously passing tests still pass (bc_train tests may now fail if bc_train.py still has `shuffle=True` — that is fixed in Task 2).

- [ ] **Step 6: Commit**

```bash
git add rl/train/bc_dataset.py rl/tests/test_bc_dataset.py
git commit -m "feat(rl): BCDataset → IterableDataset with shuffle buffer + max_games"
```

---

### Task 2: Fix DataLoader shuffle in bc_train.py

**Files:**
- Modify: `rl/train/bc_train.py:50`

**Interfaces:**
- Consumes: `BCDataset` (now `IterableDataset` — does not support `shuffle=True` in DataLoader)

- [ ] **Step 1: Confirm bc_train test currently fails (if shuffle=True triggers PyTorch error)**

```bash
rl/.venv/bin/python -m pytest rl/tests/test_bc_train.py -v
```

Note the result — it may pass (PyTorch warns but does not raise) or fail.

- [ ] **Step 2: Change `shuffle=True` to `shuffle=False` in `rl/train/bc_train.py`**

Find this line in `train_bc()`:

```python
loader = DataLoader(dataset, batch_size=batch_size, shuffle=True, num_workers=0)
```

Replace with:

```python
loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=0)
```

- [ ] **Step 3: Run full test suite — all 87 tests must pass**

```bash
rl/.venv/bin/python -m pytest rl/tests/ -q
```

Expected: all tests pass. The count increases from 87 to 89 (two new tests added in Task 1: `test_dataset_max_games` + `test_dataset_shuffle_buffer_zero_is_deterministic`).

- [ ] **Step 4: Smoke-test streaming on real data (optional but recommended)**

```bash
rl/.venv/bin/python -c "
from rl.train.bc_dataset import BCDataset
import itertools
ds = BCDataset('rl/data/bc_classic.jsonl', max_games=5, shuffle_buffer=500)
samples = list(itertools.islice(ds, 20))
print(f'Got {len(samples)} samples — no OOM')
print(f'Grid shape: {samples[0][0].shape}')
"
```

Expected output:
```
Got 20 samples — no OOM
Grid shape: torch.Size([13, 15, 12])
```

- [ ] **Step 5: Commit**

```bash
git add rl/train/bc_train.py
git commit -m "fix(rl): DataLoader shuffle=False for IterableDataset BCDataset"
```
