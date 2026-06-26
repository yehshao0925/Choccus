# RL Phase 2 — Neural Network + PPO Training

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Train a PPO agent with CNN+LSTM architecture and BC initialization that beats v6:hunter in the Python gym environment, verified by win rate > 50% vs random-safe opponents (proxy gate) and ultimately the TS CRN bench.

**Architecture:** SB3-contrib `RecurrentPPO` with a custom `ChoccusCNNExtractor` (CNN over 13×15×12 grid + concat 9 scalars → 512-dim) and LSTM(256). BC pretraining on v6:hunter self-play trajectories collected via TS sim-runner. Elo pool self-play for curriculum. Opponent during gym training = random-safe (existing `ChoccusEnv`); final gate = TS `npm run v5-probe`.

**Tech Stack:** Python 3.11+, PyTorch ≥2.0, stable-baselines3 ≥2.3, sb3-contrib ≥2.3, NumPy, Gymnasium 0.29; TypeScript (tsx) for data collection.

---

## Pre-requisites

Phase 0 + Phase 1 are complete and merged. Verify before starting:

```bash
cd /home/m2553/repo/10-choccus
rl/.venv/bin/python -m pytest rl/tests/ -q --tb=no
# Expected: 64 passed
```

---

## File Structure

```
rl/
├── requirements.txt         # MODIFY: add torch, stable-baselines3, sb3-contrib
├── train/
│   ├── __init__.py          # CREATE (empty)
│   ├── network.py           # CREATE: ChoccusCNNExtractor (BaseFeaturesExtractor)
│   ├── bc_dataset.py        # CREATE: BCDataset — replay trajectories → tensors
│   ├── bc_train.py          # CREATE: BC supervised pretraining, saves extractor
│   ├── ppo_train.py         # CREATE: RecurrentPPO training loop + BC init
│   ├── self_play.py         # CREATE: CheckpointPool + Elo rating
│   └── evaluate.py          # CREATE: win_rate_vs_random()
├── tests/
│   ├── test_network.py      # CREATE
│   ├── test_bc_dataset.py   # CREATE
│   ├── test_bc_train.py     # CREATE
│   ├── test_ppo_train.py    # CREATE
│   ├── test_self_play.py    # CREATE
│   └── test_evaluate.py     # CREATE
└── data/                    # CREATE dir (gitignored): bc_classic.jsonl, bc_pirate.jsonl

tools/sim-runner/
├── package.json             # MODIFY: add "collect-bc" script
└── src/
    └── collect-bc-data.ts   # CREATE: v6:hunter self-play → action-sequence JSONL
```

---

## Task 1: Dependencies + Project Setup

**Files:**
- Modify: `rl/requirements.txt`
- Modify: `.gitignore`
- Create: `rl/train/__init__.py`
- Create: `rl/data/.gitkeep`

- [ ] **Step 1: Update rl/requirements.txt**

```
gymnasium==0.29.1
numpy>=1.26
pytest>=8.0
torch>=2.0.0
stable-baselines3>=2.3.0
sb3-contrib>=2.3.0
```

- [ ] **Step 2: Install**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/pip install -r rl/requirements.txt
```

Expected: `Successfully installed torch-...` (may take a few minutes).

- [ ] **Step 3: Verify imports**

```bash
rl/.venv/bin/python -c "import torch; import stable_baselines3; import sb3_contrib; print('OK', torch.__version__)"
```

Expected: `OK 2.x.x`

- [ ] **Step 4: Create supporting files**

Create `rl/train/__init__.py` (empty):
```python
```

Create `rl/data/.gitkeep` (empty file, ensures the dir exists):
```bash
mkdir -p rl/data && touch rl/data/.gitkeep
```

- [ ] **Step 5: Add rl/data/ and rl/checkpoints/ to .gitignore**

Append to `.gitignore`:
```
# RL training data and checkpoints (large generated files)
rl/data/*.jsonl
rl/data/*.npz
rl/checkpoints/
```

- [ ] **Step 6: Commit**

```bash
git add rl/requirements.txt rl/train/__init__.py rl/data/.gitkeep .gitignore
git commit -m "feat(rl): Phase 2 dependencies + project setup (Task 1)"
```

---

## Task 2: CNN Feature Extractor

**Files:**
- Create: `rl/train/network.py`
- Create: `rl/tests/test_network.py`

- [ ] **Step 1: Write test_network.py (failing first)**

```python
# rl/tests/test_network.py
import torch
import numpy as np
import gymnasium as gym
from gymnasium import spaces
from rl.train.network import ChoccusCNNExtractor
from rl.env.constants import MAP_ROWS, MAP_COLS


def _obs_space():
    return spaces.Dict({
        'grid': spaces.Box(-1.0, 1.0, (MAP_ROWS, MAP_COLS, 12), np.float32),
        'scalars': spaces.Box(-1.0, 1.0, (9,), np.float32),
    })


def test_extractor_output_shape():
    extractor = ChoccusCNNExtractor(_obs_space(), features_dim=512)
    batch = {
        'grid': torch.zeros(4, MAP_ROWS, MAP_COLS, 12),
        'scalars': torch.zeros(4, 9),
    }
    out = extractor(batch)
    assert out.shape == (4, 512)


def test_extractor_no_nan():
    extractor = ChoccusCNNExtractor(_obs_space())
    batch = {
        'grid': torch.rand(2, MAP_ROWS, MAP_COLS, 12),
        'scalars': torch.rand(2, 9),
    }
    out = extractor(batch)
    assert not torch.isnan(out).any()


def test_extractor_custom_features_dim():
    extractor = ChoccusCNNExtractor(_obs_space(), features_dim=256)
    batch = {
        'grid': torch.zeros(1, MAP_ROWS, MAP_COLS, 12),
        'scalars': torch.zeros(1, 9),
    }
    out = extractor(batch)
    assert out.shape == (1, 256)
```

- [ ] **Step 2: Confirm tests fail**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/test_network.py -v 2>&1 | head -5
```

Expected: `ImportError: cannot import name 'ChoccusCNNExtractor'`

- [ ] **Step 3: Implement rl/train/network.py**

```python
# rl/train/network.py
"""
CNN feature extractor for ChoccusEnv Dict observation space.
Processes 13×15×12 grid with CNN, concatenates 9 scalar features.
Output: `features_dim`-dim vector fed to LSTM in RecurrentPPO.
"""
import torch
import torch.nn as nn
import torch.nn.functional as F
from stable_baselines3.common.torch_layers import BaseFeaturesExtractor
import gymnasium as gym


class ChoccusCNNExtractor(BaseFeaturesExtractor):
    """
    Observation: Dict{
      'grid':    float32[13, 15, 12]  — 12-channel spatial map
      'scalars': float32[9]           — per-agent stats
    }
    Architecture:
      Conv2d(12→64, 3×3, pad=1) + ReLU
      Conv2d(64→128, 3×3, pad=1) + ReLU
      Conv2d(128→128, 3×3, pad=1) + ReLU
      Flatten → Linear(128×13×15, features_dim)
      concat 9 scalars → Linear(features_dim+9, features_dim) + ReLU
    """

    def __init__(self, observation_space: gym.spaces.Dict, features_dim: int = 512):
        super().__init__(observation_space, features_dim)

        n_channels = 12  # grid channels
        self.cnn = nn.Sequential(
            nn.Conv2d(n_channels, 64, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.Conv2d(64, 128, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.Conv2d(128, 128, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.Flatten(),
        )
        # 128 filters × 13 rows × 15 cols
        cnn_out_dim = 128 * 13 * 15  # 24960
        n_scalars = 9
        self.proj = nn.Sequential(
            nn.Linear(cnn_out_dim + n_scalars, features_dim),
            nn.ReLU(),
        )

    def forward(self, observations: dict) -> torch.Tensor:
        grid = observations['grid']          # (B, 13, 15, 12)
        grid = grid.permute(0, 3, 1, 2)     # (B, 12, 13, 15)
        cnn_out = self.cnn(grid.float())     # (B, 24960)
        scalars = observations['scalars'].float()  # (B, 9)
        combined = torch.cat([cnn_out, scalars], dim=1)
        return self.proj(combined)           # (B, features_dim)
```

- [ ] **Step 4: Confirm tests pass**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/test_network.py -v
```

Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add rl/train/network.py rl/tests/test_network.py
git commit -m "feat(rl): CNN feature extractor ChoccusCNNExtractor (Task 2)"
```

---

## Task 3: BC Data Collection (TypeScript)

**Files:**
- Create: `tools/sim-runner/src/collect-bc-data.ts`
- Modify: `tools/sim-runner/package.json`

This task collects v6:hunter self-play trajectories as action sequences. Python replays them in Task 4 using the deterministic Python sim (Phase 0 guarantees byte-identical results).

No Python tests. Verification = run with --games=3 and inspect output.

- [ ] **Step 1: Add collect-bc script to tools/sim-runner/package.json**

In `tools/sim-runner/package.json`, add to the `"scripts"` block:
```json
"collect-bc": "tsx src/collect-bc-data.ts"
```

- [ ] **Step 2: Implement tools/sim-runner/src/collect-bc-data.ts**

```typescript
/**
 * Collect BC training data: run v6:hunter self-play games and save
 * action sequences to JSONL. Python replays them via Python sim.
 *
 * Usage (from repo root):
 *   cd tools/sim-runner
 *   npm run collect-bc -- --games=1000 --map=classic --out=../../rl/data/bc_classic.jsonl
 */
import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AI_VERSIONS } from '../../../client/src/ai/index';
import { createInitialState, tick } from '../../../client/src/sim/Sim';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { ActionFlags, Direction, GamePhase } from '../../../shared/types';

const FEEL = makeFeelParams();
const NUM_PLAYERS = 2;
const MAX_TICKS = 10_800;

/**
 * Map InputFrame → action index matching Python _ACTION_MAP:
 *   0=stay, 1=up, 2=down, 3=left, 4=right, 5=bomb
 * If both bomb + direction: record as bomb (action=5), drop the direction.
 */
function toActionIdx(dir: number, action: number): number {
  if (action & ActionFlags.BOMB) return 5;
  if (dir === Direction.UP)    return 1;
  if (dir === Direction.DOWN)  return 2;
  if (dir === Direction.LEFT)  return 3;
  if (dir === Direction.RIGHT) return 4;
  return 0;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      games:  { type: 'string', default: '1000' },
      map:    { type: 'string', default: 'classic' },
      out:    { type: 'string', default: '../../rl/data/bc_classic.jsonl' },
      offset: { type: 'string', default: '0' },  // seed offset (for parallel runs)
    },
    strict: false,
  });

  const numGames  = parseInt(values.games  as string, 10);
  const mapKind   = values.map    as string;
  const outPath   = values.out    as string;
  const seedOffset = parseInt(values.offset as string, 10);

  const outDir = outPath.substring(0, outPath.lastIndexOf('/'));
  if (outDir) mkdirSync(outDir, { recursive: true });

  const stream = createWriteStream(outPath, { flags: 'w' });

  for (let g = 0; g < numGames; g++) {
    const seed = seedOffset + g;

    let state = createInitialState(seed, FEEL, NUM_PLAYERS, { map: mapKind as any });

    // Independent PRNGs per slot so bots don't share RNG state.
    const bots = [0, 1].map(slot =>
      AI_VERSIONS[6].createBot(seed + slot * 1_000_000, slot, {
        difficulty: 'hard',
        strategyRaw: 'hunter',
      })
    );

    const ticks: number[][] = [];
    while (state.phase === GamePhase.PLAYING && state.tick < MAX_TICKS) {
      const inputs = bots.map((bot, slot) => bot.decide(state, slot));
      ticks.push(inputs.map(f => toActionIdx(f.dir, f.action)));
      state = tick(state, inputs);
    }

    const line = JSON.stringify({ seed, map_kind: mapKind, num_players: NUM_PLAYERS, ticks });
    stream.write(line + '\n');

    if ((g + 1) % 100 === 0) {
      process.stderr.write(`\r${g + 1}/${numGames} games collected`);
    }
  }

  await new Promise<void>(resolve => stream.end(resolve));
  process.stderr.write(`\nSaved ${numGames} games to ${outPath}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Smoke test (3 games)**

```bash
cd /home/m2553/repo/10-choccus/tools/sim-runner && npm run collect-bc -- --games=3 --map=classic --out=/tmp/bc_test.jsonl
```

Expected output:
```
3/3 games collected
Saved 3 games to /tmp/bc_test.jsonl
```

Verify output structure:
```bash
head -1 /tmp/bc_test.jsonl | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['ticks']), 'ticks, first:', d['ticks'][0])"
```

Expected: `NNN ticks, first: [N, N]` where each element is 0-5.

- [ ] **Step 4: Collect full training dataset (1000 games × 2 maps)**

This takes ~3 minutes per map. Run from `tools/sim-runner/`:
```bash
cd /home/m2553/repo/10-choccus/tools/sim-runner
npm run collect-bc -- --games=1000 --map=classic --out=../../rl/data/bc_classic.jsonl
npm run collect-bc -- --games=1000 --map=pirate  --out=../../rl/data/bc_pirate.jsonl
```

Expected: two files in `rl/data/`, each ~4-8 MB.

```bash
wc -l /home/m2553/repo/10-choccus/rl/data/bc_classic.jsonl /home/m2553/repo/10-choccus/rl/data/bc_pirate.jsonl
```

Expected: `1000` lines each.

- [ ] **Step 5: Commit**

```bash
cd /home/m2553/repo/10-choccus
git add tools/sim-runner/src/collect-bc-data.ts tools/sim-runner/package.json
git commit -m "feat(rl): BC data collector — v6:hunter self-play → action JSONL (Task 3)"
```

---

## Task 4: BC Dataset

**Files:**
- Create: `rl/train/bc_dataset.py`
- Create: `rl/tests/test_bc_dataset.py`

Replays trajectories collected in Task 3 using the Python sim (byte-identical to TS via Phase 0 guarantee), encodes each state, and returns `(grid, scalars, action)` tensors.

- [ ] **Step 1: Write test_bc_dataset.py (failing first)**

```python
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
        'ticks': [[0, 0]] * ticks,  # both players stay
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
    # A game can end before 100 ticks if a player wins
    entry = _dummy_entry(seed=1, ticks=200)
    samples = replay_trajectory(entry)
    # May have fewer than 200 ticks if game ended naturally
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
```

- [ ] **Step 2: Confirm tests fail**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/test_bc_dataset.py -v 2>&1 | head -5
```

Expected: `ImportError`

- [ ] **Step 3: Implement rl/train/bc_dataset.py**

```python
# rl/train/bc_dataset.py
"""
BCDataset: replays v6:hunter trajectory files using the Python sim and
encodes each tick as (grid, scalars, action) for BC supervised training.

Trajectory file format (JSONL): one JSON object per line:
  {"seed": int, "map_kind": str, "num_players": int, "ticks": [[int, ...]]}
where ticks[t][slot] = action index 0-5 for that player at tick t.
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

# Must match Python ChoccusEnv _ACTION_MAP and TS toActionIdx
_IDX_TO_INPUT = [
    InputFrame(dir=DIR_NONE,  action=0),           # 0: stay
    InputFrame(dir=DIR_UP,    action=0),            # 1: up
    InputFrame(dir=DIR_DOWN,  action=0),            # 2: down
    InputFrame(dir=DIR_LEFT,  action=0),            # 3: left
    InputFrame(dir=DIR_RIGHT, action=0),            # 4: right
    InputFrame(dir=DIR_NONE,  action=ACTION_BOMB),  # 5: bomb
]


def replay_trajectory(entry: dict) -> list[tuple[np.ndarray, np.ndarray, int]]:
    """
    Replay one game trajectory from seed + stored action sequence.
    Returns list of (grid [13,15,12 float32], scalars [9 float32], action int).
    Stops at game-over or when action list is exhausted.
    """
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
        action_idx = tick_actions[0]  # slot 0 is always the BC agent
        samples.append((grid, scalars, int(action_idx)))
        inputs = [_IDX_TO_INPUT[a] for a in tick_actions]
        state = sim_tick(state, inputs)
    return samples


class BCDataset(Dataset):
    """PyTorch Dataset of (grid, scalars, action) from JSONL trajectory file."""

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
```

- [ ] **Step 4: Confirm tests pass**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/test_bc_dataset.py -v
```

Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add rl/train/bc_dataset.py rl/tests/test_bc_dataset.py
git commit -m "feat(rl): BCDataset — trajectory replay + encoding (Task 4)"
```

---

## Task 5: BC Pretraining

**Files:**
- Create: `rl/train/bc_train.py`
- Create: `rl/tests/test_bc_train.py`

Supervised training of `ChoccusCNNExtractor` + linear head on BC dataset. Saves the extractor's state dict to be loaded into `RecurrentPPO` in Task 6.

- [ ] **Step 1: Write test_bc_train.py (failing first)**

```python
# rl/tests/test_bc_train.py
import json
import os
import tempfile
from rl.train.bc_train import train_bc


def _write_tiny_dataset(path: str, n_games: int = 2, n_ticks: int = 30):
    with open(path, 'w') as f:
        for seed in range(n_games):
            entry = {
                'seed': seed,
                'map_kind': 'classic',
                'num_players': 2,
                'ticks': [[0, 0]] * n_ticks,
            }
            f.write(json.dumps(entry) + '\n')


def test_train_bc_runs_and_saves_checkpoint():
    with tempfile.TemporaryDirectory() as tmpdir:
        data_path = f'{tmpdir}/data.jsonl'
        ckpt_path = f'{tmpdir}/bc_extractor.pt'
        _write_tiny_dataset(data_path, n_games=2, n_ticks=30)

        acc = train_bc(
            data_path=data_path,
            output_path=ckpt_path,
            epochs=1,
            batch_size=16,
        )
        assert 0.0 <= acc <= 1.0
        assert os.path.exists(ckpt_path)


def test_train_bc_checkpoint_loadable():
    """Verify saved checkpoint can be loaded back into ChoccusCNNExtractor."""
    import torch, numpy as np
    from gymnasium import spaces
    from rl.train.network import ChoccusCNNExtractor
    from rl.env.constants import MAP_ROWS, MAP_COLS

    with tempfile.TemporaryDirectory() as tmpdir:
        data_path = f'{tmpdir}/data.jsonl'
        ckpt_path = f'{tmpdir}/bc_extractor.pt'
        _write_tiny_dataset(data_path, n_games=2, n_ticks=30)
        train_bc(data_path=data_path, output_path=ckpt_path, epochs=1, batch_size=16)

        obs_space = spaces.Dict({
            'grid':    spaces.Box(-1.0, 1.0, (MAP_ROWS, MAP_COLS, 12), np.float32),
            'scalars': spaces.Box(-1.0, 1.0, (9,), np.float32),
        })
        extractor = ChoccusCNNExtractor(obs_space)
        state = torch.load(ckpt_path, map_location='cpu')
        extractor.load_state_dict(state)  # must not raise
```

- [ ] **Step 2: Confirm tests fail**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/test_bc_train.py -v 2>&1 | head -5
```

Expected: `ImportError`

- [ ] **Step 3: Implement rl/train/bc_train.py**

```python
# rl/train/bc_train.py
"""
Behavior Cloning pretraining for ChoccusCNNExtractor.

Trains: ChoccusCNNExtractor + Linear(512, 6) on stored v6:hunter trajectories.
Saves extractor state_dict to output_path for loading into RecurrentPPO.

Usage:
  rl/.venv/bin/python -m rl.train.bc_train \
    --data rl/data/bc_classic.jsonl \
    --epochs 10
"""
import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from gymnasium import spaces

from rl.train.network import ChoccusCNNExtractor
from rl.train.bc_dataset import BCDataset
from rl.env.constants import MAP_ROWS, MAP_COLS

N_ACTIONS = 6


def train_bc(
    data_path: str,
    output_path: str = 'rl/checkpoints/bc_extractor.pt',
    epochs: int = 10,
    batch_size: int = 512,
    lr: float = 1e-3,
    features_dim: int = 512,
) -> float:
    """Train BC model. Returns final epoch accuracy (slot-0 action prediction)."""
    obs_space = spaces.Dict({
        'grid':    spaces.Box(-1.0, 1.0, (MAP_ROWS, MAP_COLS, 12), np.float32),
        'scalars': spaces.Box(-1.0, 1.0, (9,), np.float32),
    })
    device = 'cuda' if torch.cuda.is_available() else 'cpu'

    extractor = ChoccusCNNExtractor(obs_space, features_dim=features_dim).to(device)
    head = nn.Linear(features_dim, N_ACTIONS).to(device)
    optimizer = torch.optim.Adam(
        list(extractor.parameters()) + list(head.parameters()), lr=lr
    )
    loss_fn = nn.CrossEntropyLoss()

    dataset = BCDataset(data_path)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True, num_workers=0)

    final_acc = 0.0
    for epoch in range(epochs):
        total_loss = 0.0
        correct = 0
        total = 0

        for grid, scalars, actions in loader:
            grid    = grid.to(device)
            scalars = scalars.to(device)
            actions = actions.to(device)

            features = extractor({'grid': grid, 'scalars': scalars})
            logits   = head(features)
            loss     = loss_fn(logits, actions)

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            total_loss += loss.item() * len(actions)
            correct    += (logits.argmax(1) == actions).sum().item()
            total      += len(actions)

        final_acc = correct / total if total > 0 else 0.0
        print(f"BC epoch {epoch + 1}/{epochs}: "
              f"loss={total_loss / max(total, 1):.4f}  acc={final_acc:.3f}")

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    torch.save(extractor.state_dict(), output_path)
    print(f"Saved extractor to {output_path}")
    return final_acc


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data',   required=True,  help='Path to .jsonl file')
    parser.add_argument('--out',    default='rl/checkpoints/bc_extractor.pt')
    parser.add_argument('--epochs', type=int, default=10)
    parser.add_argument('--batch',  type=int, default=512)
    parser.add_argument('--lr',     type=float, default=1e-3)
    args = parser.parse_args()
    train_bc(args.data, args.out, args.epochs, args.batch, args.lr)
```

- [ ] **Step 4: Confirm tests pass**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/test_bc_train.py -v
```

Expected: `2 passed` (may take ~30 seconds for training runs)

- [ ] **Step 5: Run production BC training (optional, run before Task 6)**

```bash
cd /home/m2553/repo/10-choccus
mkdir -p rl/checkpoints
rl/.venv/bin/python -m rl.train.bc_train \
  --data rl/data/bc_classic.jsonl \
  --out rl/checkpoints/bc_extractor_classic.pt \
  --epochs 10 --batch 512
```

Expected: Loss should decrease from ~1.8 toward ~1.0+ over 10 epochs; final accuracy ~30-50% (predicting v6:hunter moves is hard with a fixed policy, success is loss below 1.5).

- [ ] **Step 6: Commit**

```bash
git add rl/train/bc_train.py rl/tests/test_bc_train.py
git commit -m "feat(rl): BC supervised pretraining + extractor checkpoint (Task 5)"
```

---

## Task 6: PPO Training

**Files:**
- Create: `rl/train/ppo_train.py`
- Create: `rl/tests/test_ppo_train.py`

`RecurrentPPO` (sb3-contrib) with `MultiInputLstmPolicy` + `ChoccusCNNExtractor`. Loads BC extractor weights before training. Cosine LR decay 3e-4 → 1e-5.

- [ ] **Step 1: Write test_ppo_train.py (failing first)**

```python
# rl/tests/test_ppo_train.py
import pytest
from rl.train.ppo_train import make_ppo_model, make_env


def test_make_env_returns_gymnasium_env():
    env = make_env('classic')()
    obs, info = env.reset(seed=0)
    assert 'grid' in obs and 'scalars' in obs
    env.close()


def test_ppo_model_smoke_1000_steps():
    """Verify RecurrentPPO can run 1000 steps without crash."""
    from stable_baselines3.common.vec_env import DummyVecEnv
    env = DummyVecEnv([make_env('classic')])
    model = make_ppo_model(env, n_steps=64, batch_size=32, verbose=0)
    model.learn(total_timesteps=1000)
    # No crash = pass
    env.close()


def test_ppo_loads_bc_weights():
    """Verify BC extractor weights can be loaded without error."""
    import torch, tempfile, os, numpy as np
    from stable_baselines3.common.vec_env import DummyVecEnv
    from gymnasium import spaces
    from rl.train.network import ChoccusCNNExtractor
    from rl.env.constants import MAP_ROWS, MAP_COLS

    # Save a dummy extractor checkpoint
    obs_space = spaces.Dict({
        'grid':    spaces.Box(-1.0, 1.0, (MAP_ROWS, MAP_COLS, 12), np.float32),
        'scalars': spaces.Box(-1.0, 1.0, (9,), np.float32),
    })
    extractor = ChoccusCNNExtractor(obs_space)
    with tempfile.NamedTemporaryFile(suffix='.pt', delete=False) as f:
        torch.save(extractor.state_dict(), f.name)
        ckpt = f.name

    try:
        env = DummyVecEnv([make_env('classic')])
        model = make_ppo_model(env, n_steps=64, batch_size=32, verbose=0)
        # Load BC weights
        state = torch.load(ckpt, map_location='cpu')
        model.policy.features_extractor.load_state_dict(state)
        # Verify weights are loaded (not all zeros)
        w = next(model.policy.features_extractor.parameters())
        assert w.abs().sum() > 0
        env.close()
    finally:
        os.unlink(ckpt)
```

- [ ] **Step 2: Confirm tests fail**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/test_ppo_train.py -v 2>&1 | head -5
```

Expected: `ImportError`

- [ ] **Step 3: Implement rl/train/ppo_train.py**

```python
# rl/train/ppo_train.py
"""
PPO training with RecurrentPPO (sb3-contrib).
Loads BC-pretrained extractor weights as initialization.

Usage:
  rl/.venv/bin/python -m rl.train.ppo_train \
    --map classic \
    --bc rl/checkpoints/bc_extractor_classic.pt \
    --steps 10000000 \
    --envs 4
"""
import argparse
from pathlib import Path

import numpy as np
import torch
from gymnasium import spaces

from sb3_contrib import RecurrentPPO
from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv, VecMonitor
from stable_baselines3.common.callbacks import CheckpointCallback

from rl.env.choccus_env import ChoccusEnv
from rl.train.network import ChoccusCNNExtractor
from rl.env.constants import MAP_ROWS, MAP_COLS


def make_env(map_kind: str = 'classic', num_opponents: int = 1):
    """Callable factory for VecEnv wrappers."""
    def _init():
        return ChoccusEnv(map_kind=map_kind, num_opponents=num_opponents)
    return _init


def _cosine_lr(progress_remaining: float) -> float:
    """Cosine decay: 3e-4 at start → 1e-5 at end (SB3 uses 1.0→0.0 convention)."""
    import math
    cos = 0.5 * (1.0 + math.cos(math.pi * (1.0 - progress_remaining)))
    return 1e-5 + (3e-4 - 1e-5) * cos


def _linear_ent_coef(progress_remaining: float) -> float:
    """Linear decay: 0.01 at start → 0.001 at end."""
    return 0.001 + (0.01 - 0.001) * progress_remaining


def make_ppo_model(
    vec_env,
    n_steps: int = 512,
    batch_size: int = 128,
    verbose: int = 1,
) -> RecurrentPPO:
    """Construct RecurrentPPO with ChoccusCNNExtractor + LSTM(256)."""
    return RecurrentPPO(
        policy="MultiInputLstmPolicy",
        env=vec_env,
        learning_rate=_cosine_lr,
        n_steps=n_steps,
        batch_size=batch_size,
        n_epochs=4,
        gamma=0.995,
        gae_lambda=0.95,
        clip_range=0.2,
        ent_coef=_linear_ent_coef,
        verbose=verbose,
        policy_kwargs={
            "features_extractor_class": ChoccusCNNExtractor,
            "features_extractor_kwargs": {"features_dim": 512},
            "lstm_hidden_size": 256,
            "n_lstm_layers": 1,
            "net_arch": [],  # no extra MLP; Actor/Critic heads connect directly to LSTM
        },
    )


def train_ppo(
    map_kind: str = 'classic',
    n_envs: int = 4,
    total_timesteps: int = 10_000_000,
    bc_checkpoint: str | None = None,
    save_dir: str = 'rl/checkpoints',
    checkpoint_freq: int = 100_000,
):
    """
    Main training entry point.
    Loads BC extractor weights if bc_checkpoint is given, then runs RecurrentPPO.
    """
    Path(save_dir).mkdir(parents=True, exist_ok=True)

    # Use SubprocVecEnv for real parallelism; DummyVecEnv for debugging
    if n_envs > 1:
        vec_env = SubprocVecEnv([make_env(map_kind) for _ in range(n_envs)])
    else:
        vec_env = DummyVecEnv([make_env(map_kind)])
    vec_env = VecMonitor(vec_env)

    model = make_ppo_model(vec_env)

    # Load BC-pretrained extractor weights
    if bc_checkpoint and Path(bc_checkpoint).exists():
        state = torch.load(bc_checkpoint, map_location='cpu')
        model.policy.features_extractor.load_state_dict(state)
        print(f"Loaded BC weights from {bc_checkpoint}")

    ckpt_cb = CheckpointCallback(
        save_freq=checkpoint_freq // n_envs,
        save_path=save_dir,
        name_prefix=f'rl_{map_kind}',
    )

    print(f"Training on {map_kind} with {n_envs} envs for {total_timesteps:,} steps")
    model.learn(total_timesteps=total_timesteps, callback=ckpt_cb)

    final_path = f"{save_dir}/final_{map_kind}"
    model.save(final_path)
    print(f"Saved final model to {final_path}.zip")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--map',   default='classic')
    parser.add_argument('--envs',  type=int,   default=4)
    parser.add_argument('--steps', type=int,   default=10_000_000)
    parser.add_argument('--bc',    default=None, help='BC extractor .pt path')
    parser.add_argument('--save',  default='rl/checkpoints')
    parser.add_argument('--freq',  type=int,   default=100_000)
    args = parser.parse_args()
    train_ppo(args.map, args.envs, args.steps, args.bc, args.save, args.freq)
```

- [ ] **Step 4: Confirm tests pass**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/test_ppo_train.py -v
```

Expected: `3 passed` (test_ppo_model_smoke_1000_steps may take ~60 seconds)

- [ ] **Step 5: Commit**

```bash
git add rl/train/ppo_train.py rl/tests/test_ppo_train.py
git commit -m "feat(rl): RecurrentPPO training loop + cosine LR + BC init (Task 6)"
```

---

## Task 7: Evaluation Harness

**Files:**
- Create: `rl/train/evaluate.py`
- Create: `rl/tests/test_evaluate.py`

Loads a trained model and evaluates win rate vs the random-safe opponent in `ChoccusEnv`. This is the intermediate proxy gate; the ship gate requires the TS CRN bench.

- [ ] **Step 1: Write test_evaluate.py (failing first)**

```python
# rl/tests/test_evaluate.py
import numpy as np
import pytest
from rl.train.evaluate import win_rate_vs_random, MockModel


def test_mock_model_win_rate_in_range():
    """win_rate_vs_random returns float in [0, 1] for any policy."""
    model = MockModel(always_action=0)  # always stay
    rate = win_rate_vs_random(model, n_episodes=5, map_kind='classic')
    assert 0.0 <= rate <= 1.0


def test_win_rate_pirate_map():
    model = MockModel(always_action=1)  # always move up
    rate = win_rate_vs_random(model, n_episodes=5, map_kind='pirate')
    assert 0.0 <= rate <= 1.0


def test_win_rate_terminates_all_episodes():
    """Verify all N episodes terminate (no infinite loops)."""
    model = MockModel(always_action=0)
    rate = win_rate_vs_random(model, n_episodes=3, map_kind='classic', max_steps=12000)
    assert isinstance(rate, float)
```

- [ ] **Step 2: Confirm tests fail**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/test_evaluate.py -v 2>&1 | head -5
```

Expected: `ImportError`

- [ ] **Step 3: Implement rl/train/evaluate.py**

```python
# rl/train/evaluate.py
"""
Evaluation harness: win rate vs random-safe opponent in Python sim.

This is the PROXY gate used during development.
The ship gate (RL bot vs v6:hunter ≥ 50%) uses the TS bench:
  npm run v5-probe -- --target=rl:<checkpoint> --opponents=v6:hunter

Usage:
  rl/.venv/bin/python -m rl.train.evaluate \
    rl/checkpoints/final_classic.zip \
    --episodes 200 --map classic
"""
import argparse
import numpy as np

from rl.env.choccus_env import ChoccusEnv


class MockModel:
    """Deterministic test policy for unit tests (no SB3 dependency)."""
    def __init__(self, always_action: int = 0):
        self._action = always_action

    def predict(self, obs, state=None, deterministic: bool = True):
        return np.array(self._action), None


def win_rate_vs_random(
    model,
    n_episodes: int = 100,
    map_kind: str = 'classic',
    max_steps: int = 12_000,
) -> float:
    """
    Evaluate `model` for `n_episodes` in ChoccusEnv vs random-safe opponent.
    model must implement: predict(obs, state, deterministic) → (action, new_state)
    Returns fraction of episodes won by the agent (slot 0).
    """
    wins = 0
    for ep in range(n_episodes):
        env = ChoccusEnv(map_kind=map_kind, num_opponents=1)
        obs, _ = env.reset(seed=ep)
        lstm_state = None
        done = False
        last_reward = 0.0
        steps = 0

        while not done and steps < max_steps:
            action, lstm_state = model.predict(obs, state=lstm_state, deterministic=True)
            obs, last_reward, terminated, truncated, _ = env.step(int(action))
            done = terminated or truncated
            steps += 1

        if last_reward > 50.0:  # sparse win reward = +100
            wins += 1

    rate = wins / n_episodes
    print(f"Win rate vs random-safe ({map_kind}): {rate:.2%} over {n_episodes} episodes")
    return rate


if __name__ == '__main__':
    from sb3_contrib import RecurrentPPO

    parser = argparse.ArgumentParser()
    parser.add_argument('model', help='Path to .zip checkpoint')
    parser.add_argument('--episodes', type=int, default=100)
    parser.add_argument('--map', default='classic')
    args = parser.parse_args()

    model = RecurrentPPO.load(args.model)
    win_rate_vs_random(model, args.episodes, args.map)
```

- [ ] **Step 4: Confirm tests pass**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/test_evaluate.py -v
```

Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add rl/train/evaluate.py rl/tests/test_evaluate.py
git commit -m "feat(rl): evaluation harness win_rate_vs_random (Task 7)"
```

---

## Task 8: Self-Play Pool

**Files:**
- Create: `rl/train/self_play.py`
- Create: `rl/tests/test_self_play.py`

Manages an Elo-rated pool of checkpoints for curriculum training. As training progresses, add new checkpoints and sample opponents by Elo proximity. The training loop in `ppo_train.py` is re-run against pool-sampled opponents; the exact integration with `SubprocVecEnv` is handled at runtime (swap the opponent model periodically by re-creating envs).

- [ ] **Step 1: Write test_self_play.py (failing first)**

```python
# rl/tests/test_self_play.py
import pytest
from rl.train.self_play import CheckpointPool, elo_expected, elo_update


def test_elo_expected_equal_rating():
    assert abs(elo_expected(1500, 1500) - 0.5) < 1e-6


def test_elo_expected_higher_rated_favoured():
    assert elo_expected(1600, 1400) > 0.5


def test_elo_update_win_increases_winner():
    a_new, b_new = elo_update(1500, 1500, score=1.0, k=32)
    assert a_new > 1500
    assert b_new < 1500
    assert abs((a_new - 1500) + (b_new - 1500)) < 1e-6  # zero-sum


def test_elo_update_draw_unchanged_equal():
    a_new, b_new = elo_update(1500, 1500, score=0.5, k=32)
    assert abs(a_new - 1500) < 1e-6
    assert abs(b_new - 1500) < 1e-6


def test_pool_add_and_size_cap():
    pool = CheckpointPool(max_size=8)
    for i in range(10):
        pool.add(f'ckpt_{i}.zip', elo=1500 + i * 10)
    assert len(pool.entries) == 8


def test_pool_evicts_lowest_elo():
    pool = CheckpointPool(max_size=3)
    pool.add('low.zip',  elo=1300)
    pool.add('mid.zip',  elo=1500)
    pool.add('high.zip', elo=1700)
    pool.add('new.zip',  elo=1600)  # evicts 'low.zip'
    paths = [e.path for e in pool.entries]
    assert 'low.zip' not in paths
    assert 'new.zip' in paths


def test_pool_sample_returns_valid_path():
    pool = CheckpointPool()
    pool.add('a.zip', elo=1500)
    pool.add('b.zip', elo=1600)
    path = pool.sample(current_elo=1550)
    assert path in ('a.zip', 'b.zip')


def test_pool_update_elo():
    pool = CheckpointPool()
    pool.add('a.zip', elo=1500)
    pool.add('b.zip', elo=1500)
    pool.update('a.zip', 'b.zip', score=1.0)
    a = next(e for e in pool.entries if e.path == 'a.zip')
    b = next(e for e in pool.entries if e.path == 'b.zip')
    assert a.elo > 1500
    assert b.elo < 1500
```

- [ ] **Step 2: Confirm tests fail**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/test_self_play.py -v 2>&1 | head -5
```

Expected: `ImportError`

- [ ] **Step 3: Implement rl/train/self_play.py**

```python
# rl/train/self_play.py
"""
Elo-rated checkpoint pool for self-play curriculum.

Workflow:
  1. After every `checkpoint_freq` steps, save a model checkpoint.
  2. Add the checkpoint to the pool: pool.add(path, elo=current_elo_estimate)
  3. When creating the next training run, sample an opponent:
       opp_path = pool.sample(current_elo=model_elo)
  4. Load opp_path as the opponent policy in a custom env wrapper.
  5. After evaluation, update Elos: pool.update(ckpt_path, opp_path, score)

Ship gate: RL model vs v6:hunter via TS bench (not handled in this module).
"""
import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path


def elo_expected(rating_a: float, rating_b: float) -> float:
    """Expected score (win probability) for player A vs B."""
    return 1.0 / (1.0 + 10.0 ** ((rating_b - rating_a) / 400.0))


def elo_update(
    rating_a: float,
    rating_b: float,
    score: float,    # 1.0=A wins, 0.5=draw, 0.0=B wins
    k: float = 32.0,
) -> tuple[float, float]:
    """Return updated (rating_a, rating_b). Zero-sum."""
    exp_a = elo_expected(rating_a, rating_b)
    delta = k * (score - exp_a)
    return rating_a + delta, rating_b - delta


@dataclass
class PoolEntry:
    path:         str
    elo:          float = 1500.0
    games_played: int   = 0


class CheckpointPool:
    """
    Fixed-capacity pool of checkpoints with Elo ratings.
    When full, the new entry evicts the current lowest-Elo entry
    (excluding the newly added one itself).
    """

    def __init__(self, max_size: int = 8, k_factor: float = 32.0):
        self.max_size = max_size
        self.k_factor = k_factor
        self.entries:  list[PoolEntry] = []

    def add(self, path: str, elo: float = 1500.0):
        """Add checkpoint. Evicts lowest-Elo existing entry if at capacity."""
        new_entry = PoolEntry(path=path, elo=elo)
        self.entries.append(new_entry)
        if len(self.entries) > self.max_size:
            # Remove the lowest-Elo entry among all except the one just added
            worst_idx = min(
                range(len(self.entries) - 1),
                key=lambda i: self.entries[i].elo,
            )
            self.entries.pop(worst_idx)

    def sample(self, current_elo: float = 1500.0, temperature: float = 1.0) -> str:
        """
        Sample opponent path weighted by Elo proximity to current_elo.
        Closer Elo → higher probability. temperature > 1 = more uniform.
        """
        if not self.entries:
            raise ValueError("Pool is empty — add at least one checkpoint first.")
        weights = [
            math.exp(-abs(e.elo - current_elo) / (400.0 * temperature))
            for e in self.entries
        ]
        total = sum(weights)
        probs = [w / total for w in weights]
        r = random.random()
        cumulative = 0.0
        for entry, p in zip(self.entries, probs):
            cumulative += p
            if r <= cumulative:
                return entry.path
        return self.entries[-1].path

    def update(self, player_path: str, opponent_path: str, score: float):
        """
        Update Elo ratings after a match.
        score: 1.0 = player won, 0.5 = draw, 0.0 = player lost.
        """
        player  = next((e for e in self.entries if e.path == player_path),  None)
        opponent = next((e for e in self.entries if e.path == opponent_path), None)
        if player is None or opponent is None:
            return
        new_p, new_o = elo_update(player.elo, opponent.elo, score, self.k_factor)
        player.elo   = new_p
        opponent.elo = new_o
        player.games_played   += 1
        opponent.games_played += 1

    def best(self) -> PoolEntry | None:
        """Return the highest-Elo entry."""
        if not self.entries:
            return None
        return max(self.entries, key=lambda e: e.elo)

    def save(self, index_path: str):
        """Persist pool state to JSON."""
        Path(index_path).parent.mkdir(parents=True, exist_ok=True)
        data = [
            {'path': e.path, 'elo': e.elo, 'games': e.games_played}
            for e in self.entries
        ]
        with open(index_path, 'w') as f:
            json.dump({'pool': data, 'max_size': self.max_size}, f, indent=2)

    @classmethod
    def load(cls, index_path: str) -> 'CheckpointPool':
        """Restore pool from JSON file."""
        with open(index_path) as f:
            data = json.load(f)
        pool = cls(max_size=data.get('max_size', 8))
        for item in data.get('pool', []):
            e = PoolEntry(path=item['path'], elo=item['elo'], games_played=item.get('games', 0))
            pool.entries.append(e)
        return pool
```

- [ ] **Step 4: Confirm tests pass**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/test_self_play.py -v
```

Expected: `8 passed`

- [ ] **Step 5: Run full test suite — all tests should still pass**

```bash
cd /home/m2553/repo/10-choccus && rl/.venv/bin/python -m pytest rl/tests/ -q --tb=short
```

Expected: all pass (64 + new tests), 0 errors.

- [ ] **Step 6: Commit**

```bash
git add rl/train/self_play.py rl/tests/test_self_play.py
git commit -m "feat(rl): Elo checkpoint pool for self-play curriculum (Task 8)"
```

---

## Phase 2 Validation Checklist

After all 8 tasks, verify:

| Check | Command | Gate |
|---|---|---|
| All rl tests pass | `rl/.venv/bin/python -m pytest rl/tests/ -q` | 0 failures |
| SB3 imports work | `rl/.venv/bin/python -c "from sb3_contrib import RecurrentPPO; print('OK')"` | OK |
| PPO smoke (1000 steps) | `rl/.venv/bin/python -m pytest rl/tests/test_ppo_train.py::test_ppo_model_smoke_1000_steps -v` | PASSED |
| BC dataset builds | `rl/.venv/bin/python -c "from rl.train.bc_dataset import BCDataset; ds=BCDataset('rl/data/bc_classic.jsonl'); print(len(ds), 'samples')"` | > 100,000 samples |
| BC training converges | `rl/.venv/bin/python -m rl.train.bc_train --data rl/data/bc_classic.jsonl --epochs 5` | Final loss < 1.5 |

### Starting Full Training (after validation)

```bash
# Train on classic map with BC init (run in a screen/tmux session):
cd /home/m2553/repo/10-choccus
rl/.venv/bin/python -m rl.train.ppo_train \
  --map classic \
  --bc rl/checkpoints/bc_extractor_classic.pt \
  --steps 10000000 \
  --envs 4 \
  --save rl/checkpoints

# Repeat for pirate map:
rl/.venv/bin/python -m rl.train.ppo_train \
  --map pirate \
  --bc rl/checkpoints/bc_extractor_classic.pt \
  --steps 10000000 \
  --envs 4 \
  --save rl/checkpoints
```

### Proxy Gate (intermediate, Python-only)

```bash
rl/.venv/bin/python -m rl.train.evaluate rl/checkpoints/final_classic.zip --episodes 200 --map classic
# Target: > 50% vs random-safe (easy bar; real gate is TS bench)
```

### Ship Gate (TS bench, after Phase 3 ONNX export)

After ONNX export (Phase 3):
```bash
cd tools/sim-runner
npm run v5-probe -- --target=rl:hunter --opponents=v6:hunter --map=classic --repeats=300
npm run v5-probe -- --target=rl:hunter --opponents=v6:hunter --map=pirate  --repeats=300
# Gate: ≥ 50% win rate both maps
```
