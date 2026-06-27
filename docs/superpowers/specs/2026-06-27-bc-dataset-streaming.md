# BCDataset Streaming Refactor — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `BCDataset` from a fully-materialized `Dataset` to a streaming `IterableDataset` with an in-memory shuffle buffer and optional `max_games` cap, so BC pretraining can run on low-RAM machines (WSL2, 7.8 GB) without OOM.

**Architecture:** `BCDataset` changes base class from `torch.utils.data.Dataset` to `IterableDataset`. `__init__` stores only file path and config; `__iter__` replays JSONL games one at a time, fills a shuffle buffer, and yields batches of samples. `bc_train.py` drops `shuffle=True` from `DataLoader`. Existing tests are updated to remove `__len__` assumptions.

**Tech Stack:** Python 3.12, PyTorch `IterableDataset`, existing `rl/env/sim.py` replay logic.

---

## File Changes

| File | Action |
|------|--------|
| `rl/train/bc_dataset.py` | Rewrite `BCDataset` — new base class, new `__iter__`, keep `replay_trajectory` unchanged |
| `rl/train/bc_train.py` | Change `DataLoader(..., shuffle=True)` → `shuffle=False` |
| `rl/tests/test_bc_dataset.py` | Update tests: remove `len()` calls, use `islice` / iteration patterns |

---

## Specification

### `BCDataset` (rl/train/bc_dataset.py)

```python
class BCDataset(IterableDataset):
    def __init__(
        self,
        jsonl_path: str,
        max_games: int | None = None,
        shuffle_buffer: int = 5_000,
    ):
        ...

    def __iter__(self) -> Iterator[tuple[Tensor, Tensor, Tensor]]:
        ...
```

**Constructor:**
- `jsonl_path`: path to JSONL file (one game per line)
- `max_games`: if set, stop after reading this many games (for local debug runs); `None` = read all games
- `shuffle_buffer`: number of samples held in memory for in-place shuffling before yielding; `0` = no shuffle (deterministic order for tests)

**`__iter__` behaviour (exact algorithm):**

```
buffer = []
games_read = 0
for each line in jsonl_path:
    if max_games is not None and games_read >= max_games:
        break
    entry = json.loads(line)
    for (grid, scalars, action) in replay_trajectory(entry):
        buffer.append((torch.from_numpy(grid.copy()), torch.from_numpy(scalars.copy()), torch.tensor(action, dtype=torch.long)))
        if shuffle_buffer > 0 and len(buffer) >= shuffle_buffer:
            random.shuffle(buffer)
            yield from buffer
            buffer = []
    games_read += 1

# flush
if buffer:
    if shuffle_buffer > 0:
        random.shuffle(buffer)
    yield from buffer
```

**`replay_trajectory` stays unchanged** — no modifications to its signature or behaviour.

**No `__len__`** — `IterableDataset` does not support `__len__`. Callers must not call `len(dataset)`.

**Multi-worker note:** `num_workers=0` is assumed for now (current `bc_train.py` default). Multi-worker sharding is out of scope — the existing single-process training loop is sufficient.

---

### `bc_train.py` change

One line change in `train_bc()`:

```python
# Before:
loader = DataLoader(dataset, batch_size=batch_size, shuffle=True, num_workers=0)

# After:
loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=0)
```

Shuffle responsibility is delegated to `BCDataset`'s internal buffer.

---

### Test updates (rl/tests/test_bc_dataset.py)

Tests must not call `len(dataset)`. Replacement patterns:

```python
# Before (will raise TypeError):
assert len(dataset) > 0

# After:
samples = list(itertools.islice(dataset, 10))
assert len(samples) > 0

# Counting all samples:
total = sum(1 for _ in dataset)
assert total > 0
```

Tests that verify deterministic order should pass `shuffle_buffer=0`:

```python
dataset = BCDataset(path, shuffle_buffer=0)
```

---

## Memory Footprint

| Scenario | RAM |
|----------|-----|
| Full 1000-game classic, `shuffle_buffer=5000` | ≈ 47 MB buffer + 1 batch |
| `max_games=100` debug run | ≤ buffer size |
| Old fully-materialized 1000 games | ≈ 44 GB (OOM on 7.8 GB machine) |

---

## Out of Scope

- Multi-worker DataLoader sharding (not needed for single-machine BC training)
- Pre-computed numpy memmap option
- Pirate vs classic data mixing within one `BCDataset` instance
- Any changes to `bc_train.py` beyond the `shuffle=False` line
