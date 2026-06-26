# RL Agent — Phase 0 + Phase 1 實作計畫
# (Python Sim 移植 + Gymnasium 環境)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移植 TypeScript sim 到 Python，通過 Phase 0 決定性關卡（同 seed 結果 100/100 一致），並包裝成 Gymnasium 環境，供後續 PPO 訓練使用。

**Architecture:** `rl/env/` 下逐模組對齊 `client/src/sim/`，全部 int32 millitile 整數運算；`rl/env/choccus_env.py` 是 Gymnasium wrapper，輸出 15×13×12 網格 + 9 維 scalar；Phase 0 關卡用 TS sim-runner 生成固定劇本對局 JSON，Python 回放後比對勝者與時長。

**Tech Stack:** Python 3.11+, NumPy, Gymnasium 0.29, pytest

---

## 檔案結構

```
rl/
├── __init__.py
├── env/
│   ├── __init__.py
│   ├── constants.py        # 鏡像 shared/constants.ts
│   ├── types.py            # TileKind, Direction, ActionFlags, etc.
│   ├── prng.py             # Mulberry32（逐行對齊 sim/Prng.ts）
│   ├── map_gen.py          # 地圖樣板 + spawn clear（對齊 sim/Map.ts）
│   ├── player.py           # PlayerState + 移動（millitile，corner assist）
│   ├── bomb.py             # BombState + 放彈邏輯
│   ├── explosion.py        # processDetonations + explosionCovers（lenient hitbox）
│   ├── item.py             # ItemState + applyItem
│   ├── shell.py            # trap/rescue 邏輯（對齊 sim/Shell.ts）
│   ├── sudden_death.py     # 縮圈螺旋（對齊 sim/SuddenDeath.ts）
│   ├── sim.py              # SimState dataclass + tick()
│   ├── state_encoder.py    # SimState → numpy arrays（12ch + 9 scalars）
│   ├── action_mask.py      # BFS 安全濾網
│   └── choccus_env.py      # Gymnasium wrapper
├── tests/
│   ├── __init__.py
│   ├── fixtures/
│   │   └── phase0_scenarios.json  # TS sim 生成的固定劇本對局結果
│   ├── test_prng.py
│   ├── test_map_gen.py
│   ├── test_player.py
│   ├── test_explosion.py
│   ├── test_shell.py
│   ├── test_sudden_death.py
│   ├── test_sim.py
│   ├── test_phase0_determinism.py
│   ├── test_state_encoder.py
│   ├── test_action_mask.py
│   └── test_gymnasium_env.py
└── requirements.txt
tools/sim-runner/src/
└── gen-phase0-scenarios.ts  # 新增：生成 Phase 0 測試夾具
```

---

## Task 1：專案架構 + constants + types

**Files:**
- Create: `rl/__init__.py`
- Create: `rl/env/__init__.py`
- Create: `rl/tests/__init__.py`
- Create: `rl/tests/fixtures/.gitkeep`
- Create: `rl/requirements.txt`
- Create: `rl/env/constants.py`
- Create: `rl/env/types.py`

- [ ] **Step 1: 建立目錄與空檔案**

```bash
mkdir -p rl/env rl/tests/fixtures
touch rl/__init__.py rl/env/__init__.py rl/tests/__init__.py rl/tests/fixtures/.gitkeep
```

- [ ] **Step 2: 寫 requirements.txt**

```
# rl/requirements.txt
gymnasium==0.29.1
numpy>=1.26
pytest>=8.0
```

- [ ] **Step 3: 寫 rl/env/constants.py**

逐行對齊 `shared/constants.ts`：

```python
# rl/env/constants.py
TICK_HZ = 60
TICK_MS = 1000 / TICK_HZ

MAP_COLS = 15
MAP_ROWS = 13
TILE_PX = 44

SOFT_BRICK_RATE = 0.72
SPAWN_CLEAR_TILES = 3

FUSE_TICKS = round(3.0 * TICK_HZ)    # 180
SPARK_TICKS = round(0.45 * TICK_HZ)  # 27
PUSH_CHARGE_TICKS = round(0.5 * TICK_HZ)  # 30

ITEM_DROP_RATE = 0.50
ITEM_KIND_WEIGHT = 1 / 3

TRAPPED_TICKS = round(5.0 * TICK_HZ)       # 300
RESPAWN_PROTECT_TICKS = round(4.0 * TICK_HZ)  # 240

MATCH_MAX_TICKS = round(180 * TICK_HZ)  # 10800

HIT_COVER_NUM = 2
HIT_COVER_DEN = 3

SUDDEN_DEATH_START_TICK = 7200
SUDDEN_DEATH_TILE_INTERVAL = 18

PLAYER_START_HP = 1
PLAYER_START_FIRE = 2
PLAYER_MAX_FIRE = 7
PLAYER_START_CANNON = 1
PLAYER_MAX_CANNON = 6
PLAYER_START_SPEED_BONUS = 0
SPEED_BONUS_PER_ITEM = 1.0
SPEED_BONUS_CAP = 3.0

DEFAULT_MOVE_SPEED = 5.0
DEFAULT_CORNER_ASSIST = 0.25
DEFAULT_INPUT_BUFFER_MS = 120

MILLITILE = 1000

INPUT_DELAY_TICKS = 2
STALL_TIMEOUT_MS = 200
HASH_REPORT_INTERVAL = 30

RESCUE_DIST_MT = MILLITILE // 2  # 500
```

- [ ] **Step 4: 寫 rl/env/types.py**

逐行對齊 `shared/types.ts`：

```python
# rl/env/types.py
from typing import NamedTuple

# TileKind
TILE_EMPTY = 0
TILE_HARD  = 1
TILE_SOFT  = 2
TILE_PUSH  = 3

def is_destructible_brick(kind: int) -> bool:
    return kind == TILE_SOFT or kind == TILE_PUSH

# Direction bitflags (same as Direction in types.ts)
DIR_NONE  = 0
DIR_UP    = 1 << 0  # 1
DIR_DOWN  = 1 << 1  # 2
DIR_LEFT  = 1 << 2  # 4
DIR_RIGHT = 1 << 3  # 8

# ActionFlags
ACTION_NONE = 0
ACTION_BOMB = 1 << 0  # 1

# GamePhase
PHASE_LOBBY   = 0
PHASE_PLAYING = 1
PHASE_OVER    = 2

# ItemKind
ITEM_FIRE   = 0
ITEM_SPEED  = 1
ITEM_CANNON = 2


class InputFrame(NamedTuple):
    dir: int     # Direction bitflag
    action: int  # ActionFlags bitflag


NO_INPUT = InputFrame(dir=DIR_NONE, action=ACTION_NONE)
```

- [ ] **Step 5: 驗証 import 正常**

```bash
cd /home/m2553/repo/10-choccus && python3 -c "from rl.env.constants import FUSE_TICKS, MILLITILE; assert FUSE_TICKS == 180; assert MILLITILE == 1000; print('OK')"
```

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add rl/ && git commit -m "feat(rl): scaffold + constants + types (Phase 0 Task 1)"
```

---

## Task 2：PRNG（Mulberry32）

**Files:**
- Create: `rl/env/prng.py`
- Create: `rl/tests/test_prng.py`

- [ ] **Step 1: 寫 test_prng.py（先失敗）**

參考向量由 TS 生成：`prngNext(0)` → state=`0x6d2b79f5`, output=`0xefaa4d6e`（從 Prng.ts 手算）。

```python
# rl/tests/test_prng.py
import pytest
from rl.env.prng import prng_next, prng_float, prng_int


def test_prng_next_known_vector():
    # JavaScript: prngNext(0) → s = (0 + 0x6D2B79F5) & 0xFFFFFFFF = 0x6D2B79F5
    out, new_state = prng_next(0)
    assert new_state == 0x6D2B79F5
    # out is deterministic — verify it stays the same across runs
    out2, _ = prng_next(0)
    assert out == out2


def test_prng_next_chain():
    # Two sequential calls must thread state correctly
    out1, s1 = prng_next(42)
    out2, s2 = prng_next(s1)
    out3, s3 = prng_next(s2)
    # All outputs must be different (extremely unlikely to collide)
    assert len({out1, out2, out3}) == 3


def test_prng_float_range():
    s = 12345
    for _ in range(1000):
        v, s = prng_float(s)
        assert 0.0 <= v < 1.0


def test_prng_int_range():
    s = 99999
    for _ in range(1000):
        v, s = prng_int(s, 0, 2)
        assert v in (0, 1, 2)


def test_prng_int_span():
    # Should eventually produce all values in [0, 5]
    s = 1
    seen = set()
    for _ in range(1000):
        v, s = prng_int(s, 0, 5)
        seen.add(v)
    assert seen == {0, 1, 2, 3, 4, 5}
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_prng.py -v 2>&1 | head -20
```

Expected: `ImportError: No module named 'rl.env.prng'`

- [ ] **Step 3: 實作 rl/env/prng.py**

逐行對齊 `client/src/sim/Prng.ts`：

```python
# rl/env/prng.py
"""
Mulberry32 — seeded deterministic PRNG.
Pure: all functions return (value, new_state). Caller threads new_state back.
Ported from client/src/sim/Prng.ts — must produce bit-identical output.
"""

_MASK = 0xFFFF_FFFF


def prng_next(state: int) -> tuple[int, int]:
    """Advance generator once. Returns (uint32 output, new uint32 state).
    Mirrors: prngNext(state) in Prng.ts"""
    s = (state + 0x6D2B79F5) & _MASK
    t = s
    # Math.imul(t ^ (t >>> 15), t | 1)
    t = ((t ^ (t >> 15)) * (t | 1)) & _MASK
    # t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    inner = ((t ^ (t >> 7)) * (t | 61)) & _MASK
    t = (t ^ (t + inner)) & _MASK
    return ((t ^ (t >> 14)) & _MASK, s)


def prng_float(state: int) -> tuple[float, int]:
    """Uniform float in [0, 1). Mirrors: prngFloat(state) in Prng.ts"""
    v, s = prng_next(state)
    return v / 4_294_967_296.0, s


def prng_int(state: int, min_val: int, max_inclusive: int) -> tuple[int, int]:
    """Uniform integer in [min_val, max_inclusive]. Mirrors: prngInt in Prng.ts"""
    v, s = prng_next(state)
    span = max_inclusive - min_val + 1
    return min_val + (v % span), s
```

- [ ] **Step 4: 確認測試通過**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_prng.py -v
```

Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add rl/env/prng.py rl/tests/test_prng.py && git commit -m "feat(rl): Mulberry32 PRNG (Task 2)"
```

---

## Task 3：地圖生成

**Files:**
- Create: `rl/env/map_gen.py`
- Create: `rl/tests/test_map_gen.py`

- [ ] **Step 1: 寫 test_map_gen.py（先失敗）**

```python
# rl/tests/test_map_gen.py
import numpy as np
import pytest
from rl.env.map_gen import generate_map, map_spawns, MAP_KINDS
from rl.env.constants import MAP_COLS, MAP_ROWS, MILLITILE
from rl.env.types import TILE_EMPTY, TILE_HARD, TILE_SOFT, TILE_PUSH


def test_generate_map_shape():
    grid, prng_out = generate_map(0, "classic")
    assert grid.shape == (MAP_ROWS * MAP_COLS,)
    assert grid.dtype == np.uint8


def test_generate_map_prng_unchanged():
    # Authored maps draw ZERO PRNG values (see Map.ts comment)
    seed = 42
    _, prng_out = generate_map(seed, "classic")
    assert prng_out == seed


def test_classic_has_hard_corners():
    grid, _ = generate_map(0, "classic")
    # (0,0) is '@' → EMPTY after spawn clear; (1,1) is '.' → EMPTY
    # Row 1, col 1 in classic template: '#' → HARD
    # Actually template row 1 = '.#S#S#S#S#S#S#.' → col 1 = '#' → HARD
    assert grid[1 * MAP_COLS + 1] == TILE_HARD


def test_spawns_are_walkable():
    grid, _ = generate_map(0, "classic")
    spawns = map_spawns("classic")
    assert len(spawns) == 4
    for (sx, sy) in spawns:
        assert grid[sy * MAP_COLS + sx] == TILE_EMPTY


def test_all_map_kinds():
    for kind in MAP_KINDS:
        grid, _ = generate_map(0, kind)
        assert grid.shape == (MAP_ROWS * MAP_COLS,)


def test_pirate_spawns():
    spawns = map_spawns("pirate")
    assert len(spawns) == 4
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_map_gen.py -v 2>&1 | head -5
```

Expected: `ImportError`

- [ ] **Step 3: 實作 rl/env/map_gen.py**

逐行對齊 `client/src/sim/Map.ts`：

```python
# rl/env/map_gen.py
"""
Map generation — authored templates only, draws ZERO PRNG.
Ported from client/src/sim/Map.ts.
"""
import numpy as np
from rl.env.constants import MAP_COLS, MAP_ROWS
from rl.env.types import TILE_EMPTY, TILE_HARD, TILE_SOFT, TILE_PUSH

# Authored templates: '#'=HARD, 'S'=SOFT, 'P'=PUSH, '.'=EMPTY, '@'=spawn(EMPTY)
CLASSIC_TEMPLATE = [
    '@.SPSS...SSPS.@',
    '.#S#S#S#S#S#S#.',
    'SSSSSSSSSSSSSSS',
    'P#S#S#S#S#S#S#P',
    'SSSSSSSSSSSSSSS',
    '.#S#S#S#S#S#S#.',
    '..SSSSSSSSSSS..',
    '.#S#S#S#S#S#S#.',
    'SSSSSSSSSSSSSSS',
    'P#S#S#S#S#S#S#P',
    'SSSSSSSSSSSSSSS',
    '.#S#S#.#.#S#S#.',
    '@.SPSS...SSPS.@',
]

PIRATE_TEMPLATE = [
    'SSSS.@.S.@.SSSS',
    'S#S.PPP.PPP.S#S',
    'SS.P.S.P.S.P.SS',
    'S.P.SSSSSSS.P.S',
    'S.PSSSSSSSSSP.S',
    'S.P.SSSSSSS.P.S',
    'S.PSSS###SSSP.S',
    'SS.P.SSSSS.P.SS',
    'SSS.PSSSSSP.SSS',
    'SSSS.P.S.P.SSSS',
    'SS.SS.PPP.SS.SS',
    'S#.SSS...SSS.#S',
    'S@.SSSSSSSSS.@S',
]

VILLAGE_TEMPLATE = [
    '@.SSS...P.#S#@#',
    '.#PSP#P..#SS...',
    '..SSSS.PP.#P#P#',
    'P#P#P#P..#SSSSS',
    'SSSSSS..P.#P#P#',
    'S#S#S#PP..SSSSS',
    '#.#.#...P.#.#.#',
    'SSSSS.P..#S#S#S',
    '#P#PS#.PPSSSSSS',
    '#SSSSSP..#P#P#S',
    '#S#PS#P.PSSSSS.',
    '#@SSSS.P.#P#P#.',
    '######..P.SSS.@',
]

MAP_TEMPLATES: dict[str, list[str]] = {
    'classic': CLASSIC_TEMPLATE,
    'pirate':  PIRATE_TEMPLATE,
    'village': VILLAGE_TEMPLATE,
}
MAP_KINDS = list(MAP_TEMPLATES.keys())


def _template_tile(ch: str) -> int:
    if ch == '#': return TILE_HARD
    if ch == 'S': return TILE_SOFT
    if ch == 'P': return TILE_PUSH
    return TILE_EMPTY  # '.' and '@'


def _spawns_of(tmpl: list[str]) -> list[tuple[int, int]]:
    out = []
    for y in range(MAP_ROWS):
        for x in range(MAP_COLS):
            if tmpl[y][x] == '@':
                out.append((x, y))
    return out


def _spawn_clear_set(spawns: list[tuple[int, int]]) -> set[int]:
    clear: set[int] = set()
    for (sx, sy) in spawns:
        clear.add(sy * MAP_COLS + sx)
        for (nx, ny) in [(sx+1, sy), (sx-1, sy), (sx, sy+1), (sx, sy-1)]:
            # Skip outer ring and out-of-bounds
            if 0 < nx < MAP_COLS - 1 and 0 < ny < MAP_ROWS - 1:
                clear.add(ny * MAP_COLS + nx)
    return clear


def generate_map(prng: int, kind: str = 'classic') -> tuple[np.ndarray, int]:
    """Generate grid from authored template. Draws ZERO PRNG (returns prng unchanged)."""
    tmpl = MAP_TEMPLATES.get(kind, CLASSIC_TEMPLATE)
    spawns = _spawns_of(tmpl)
    clear = _spawn_clear_set(spawns)
    grid = np.zeros(MAP_ROWS * MAP_COLS, dtype=np.uint8)
    for y in range(MAP_ROWS):
        for x in range(MAP_COLS):
            i = y * MAP_COLS + x
            grid[i] = TILE_EMPTY if i in clear else _template_tile(tmpl[y][x])
    return grid, prng  # prng unchanged


def map_spawns(kind: str) -> list[tuple[int, int]]:
    """Spawn positions for the given map kind, in slot order."""
    tmpl = MAP_TEMPLATES.get(kind, CLASSIC_TEMPLATE)
    spawns = _spawns_of(tmpl)
    return spawns if spawns else [(1, 1), (MAP_COLS-2, 1), (1, MAP_ROWS-2), (MAP_COLS-2, MAP_ROWS-2)]
```

- [ ] **Step 4: 確認測試通過**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_map_gen.py -v
```

Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add rl/env/map_gen.py rl/tests/test_map_gen.py && git commit -m "feat(rl): map generation from authored templates (Task 3)"
```

---

## Task 4：Player State + 移動模型

**Files:**
- Create: `rl/env/player.py`
- Create: `rl/tests/test_player.py`

- [ ] **Step 1: 寫 test_player.py（先失敗）**

```python
# rl/tests/test_player.py
import numpy as np
import pytest
from rl.env.player import (
    create_player, tile_of, player_speed_mt_per_tick, step_entity
)
from rl.env.map_gen import generate_map
from rl.env.constants import MILLITILE, DEFAULT_MOVE_SPEED, DEFAULT_CORNER_ASSIST, TICK_HZ
from rl.env.types import DIR_RIGHT, DIR_LEFT, DIR_UP, DIR_DOWN, TILE_HARD


def _open_always(ax, bx):
    return True


def _open_never(ax, bx):
    return False


def test_tile_of_center():
    assert tile_of(0) == 0
    assert tile_of(1000) == 1
    assert tile_of(2000) == 2


def test_tile_of_half_rounds_up():
    # JavaScript Math.round(500/1000) = 1 (rounds half-up)
    assert tile_of(500) == 1
    assert tile_of(499) == 0


def test_create_player_position():
    p = create_player(slot=0, tile_x=1, tile_y=1)
    assert p['pos_x'] == 1000
    assert p['pos_y'] == 1000
    assert p['alive'] is True
    assert p['trapped'] is False


def test_speed_default():
    speed = player_speed_mt_per_tick(
        move_speed_mt=round(DEFAULT_MOVE_SPEED * MILLITILE),
        speed_bonus_tenths=0
    )
    # round((5000 + 0) / 60) = round(83.33) = 83
    assert speed == 83


def test_step_entity_moves_right():
    move_speed = player_speed_mt_per_tick(round(DEFAULT_MOVE_SPEED * MILLITILE), 0)
    nx, ny, moved = step_entity(
        open_fn=lambda at, bt: True,
        pos_x=1000, pos_y=1000,
        direction=DIR_RIGHT,
        speed_mt=move_speed,
        tol_mt=round(DEFAULT_CORNER_ASSIST * MILLITILE)
    )
    assert moved is True
    assert nx > 1000
    assert ny == 1000


def test_step_entity_blocked():
    nx, ny, moved = step_entity(
        open_fn=lambda at, bt: False,
        pos_x=1000, pos_y=1000,
        direction=DIR_RIGHT,
        speed_mt=83,
        tol_mt=250
    )
    # Blocked: clamped to tile center (already at center)
    assert moved is False
    assert nx == 1000
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_player.py -v 2>&1 | head -5
```

Expected: `ImportError`

- [ ] **Step 3: 實作 rl/env/player.py**

逐行對齊 `client/src/sim/Player.ts`：

```python
# rl/env/player.py
"""
Player state and grid-movement helper.
Ported from client/src/sim/Player.ts — all coordinates in int millitiles.

Movement invariant (same as TS): at least one axis is always at a tile center.
"""
from typing import Callable
from rl.env.constants import (
    MILLITILE, TICK_HZ,
    PLAYER_START_FIRE, PLAYER_START_CANNON, PLAYER_START_SPEED_BONUS,
    DEFAULT_MOVE_SPEED, DEFAULT_CORNER_ASSIST, DEFAULT_INPUT_BUFFER_MS,
)
from rl.env.types import DIR_NONE, DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT


def tile_of(mt: int) -> int:
    """Nearest tile index for a millitile coordinate.
    Replicates JavaScript Math.round(mt / MILLITILE): rounds half-up for positive values."""
    # (mt + 500) // 1000 gives half-up rounding for non-negative mt.
    return (mt + 500) // 1000


def create_player(slot: int, tile_x: int, tile_y: int, team: int = 0) -> dict:
    return {
        'slot': slot,
        'team': team,
        'alive': True,
        'trapped': False,
        'trapped_ticks': 0,
        'pos_x': tile_x * MILLITILE,
        'pos_y': tile_y * MILLITILE,
        'facing': DIR_DOWN,
        'fire': PLAYER_START_FIRE,
        'cannon': PLAYER_START_CANNON,
        'speed_bonus_tenths': PLAYER_START_SPEED_BONUS,
        'active_bombs': 0,
        'held_stack': [],
        'prev_dir': 0,
        'prev_action': 0,
        'buffered_dir': 0,
        'buffered_ticks': 0,
        'push_charge_dir': 0,
        'push_charge_ticks': 0,
    }


def player_speed_mt_per_tick(move_speed_mt: int, speed_bonus_tenths: int) -> int:
    """Effective per-tick speed in millitiles. Mirrors playerSpeedMtPerTick in Player.ts."""
    return round((move_speed_mt + speed_bonus_tenths * 100) / TICK_HZ)


def _dir_dx(d: int) -> int:
    return -1 if d == DIR_LEFT else (1 if d == DIR_RIGHT else 0)


def _dir_dy(d: int) -> int:
    return -1 if d == DIR_UP else (1 if d == DIR_DOWN else 0)


# open_fn signature: (a_tile: int, b_tile: int) -> bool
# where a_tile = tile on the movement axis, b_tile = perpendicular tile
OpenFn = Callable[[int, int], bool]


def _move_straight(open_fn: OpenFn, a: int, b_tile: int, sign: int, speed: int) -> int:
    """Advance along one axis; clamp to current tile center if blocked ahead."""
    c = tile_of(a)
    na = a + sign * speed
    if not open_fn(c + sign, b_tile):
        if sign > 0:
            na = min(na, max(a, c * MILLITILE))
        else:
            na = max(na, min(a, c * MILLITILE))
    return na


def _step_axis(
    open_fn: OpenFn, a: int, b: int, sign: int, speed: int, tol_mt: int
) -> tuple[int, int, bool]:
    """One movement attempt along axis `a`, with corner assist on axis `b`."""
    b_near = tile_of(b)
    off_b = b - b_near * MILLITILE
    if off_b == 0:
        na = _move_straight(open_fn, a, b_near, sign, speed)
        return na, b, na != a
    # Corner assist: `a` is at a tile center here (movement invariant)
    a_tile = tile_of(a)
    candidates = [b_near, b_near + (1 if off_b > 0 else -1)]
    for r in candidates:
        dist = abs(b - r * MILLITILE)
        if dist > MILLITILE // 2 + tol_mt:
            continue
        if not open_fn(a_tile + sign, r):
            continue
        if r != b_near and not open_fn(a_tile, r):
            continue
        dir_b = 1 if r * MILLITILE > b else -1
        slide = min(speed, dist)
        nb = b + dir_b * slide
        na = a
        rest = speed - slide
        if rest > 0 and nb == r * MILLITILE:
            na = _move_straight(open_fn, a, r, sign, rest)
        return na, nb, True
    return a, b, False


def step_entity(
    open_fn: OpenFn,
    pos_x: int, pos_y: int,
    direction: int,
    speed_mt: int,
    tol_mt: int,
) -> tuple[int, int, bool]:
    """Move entity one tick in `direction`. Returns (new_x, new_y, moved)."""
    dx = _dir_dx(direction)
    if dx != 0:
        return _step_axis(open_fn, pos_x, pos_y, dx, speed_mt, tol_mt)
    dy = _dir_dy(direction)
    if dy != 0:
        na, nb, moved = _step_axis(
            lambda at, bt: open_fn(bt, at), pos_y, pos_x, dy, speed_mt, tol_mt
        )
        return nb, na, moved
    return pos_x, pos_y, False
```

- [ ] **Step 4: 確認測試通過**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_player.py -v
```

Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add rl/env/player.py rl/tests/test_player.py && git commit -m "feat(rl): player state + millitile movement model (Task 4)"
```

---

## Task 5：炸彈系統 + Explosion 處理 + Lenient Hitbox

**Files:**
- Create: `rl/env/bomb.py`
- Create: `rl/env/explosion.py`
- Create: `rl/tests/test_explosion.py`

- [ ] **Step 1: 寫 test_explosion.py（先失敗）**

```python
# rl/tests/test_explosion.py
import numpy as np
import pytest
from rl.env.map_gen import generate_map
from rl.env.bomb import create_bomb, bomb_at
from rl.env.explosion import process_detonations, explosion_covers
from rl.env.constants import (
    MILLITILE, FUSE_TICKS, SPARK_TICKS, MAP_COLS, MAP_ROWS, HIT_COVER_NUM, HIT_COVER_DEN
)
from rl.env.types import TILE_EMPTY, TILE_SOFT, TILE_HARD


def _make_empty_grid() -> np.ndarray:
    grid = np.zeros(MAP_ROWS * MAP_COLS, dtype=np.uint8)
    return grid


def test_bomb_at_finds_bomb():
    bombs = [create_bomb(owner_slot=0, tile_x=3, tile_y=3, fire=2)]
    b = bomb_at(bombs, 3, 3)
    assert b is not None
    assert b['tile_x'] == 3


def test_process_detonations_basic():
    grid = _make_empty_grid()
    # Bomb with fire=2 at (7,6), fuse expired
    bombs = [{'owner_slot': 0, 'tile_x': 7, 'tile_y': 6, 'fuse_ticks': 0, 'fire': 2}]
    result = process_detonations(grid, bombs, prng=0)
    cells = result['cells']
    detonated = result['detonated_owners']
    assert 0 in detonated
    # Should have cells at center + up to 2 steps in each arm
    cell_coords = {(c['tile_x'], c['tile_y']) for c in cells}
    assert (7, 6) in cell_coords  # center


def test_explosion_stops_at_hard():
    grid = _make_empty_grid()
    grid[6 * MAP_COLS + 8] = TILE_HARD  # wall at (8, 6)
    bombs = [{'owner_slot': 0, 'tile_x': 7, 'tile_y': 6, 'fuse_ticks': 0, 'fire': 3}]
    result = process_detonations(grid, bombs, prng=0)
    cell_coords = {(c['tile_x'], c['tile_y']) for c in result['cells']}
    assert (8, 6) not in cell_coords   # HARD: blocked, not a cell
    assert (9, 6) not in cell_coords   # behind wall: not reached


def test_explosion_destroys_soft_and_stops():
    grid = _make_empty_grid()
    grid[6 * MAP_COLS + 8] = TILE_SOFT
    bombs = [{'owner_slot': 0, 'tile_x': 7, 'tile_y': 6, 'fuse_ticks': 0, 'fire': 3}]
    result = process_detonations(grid, bombs, prng=0)
    cell_coords = {(c['tile_x'], c['tile_y']) for c in result['cells']}
    # Soft brick at (8,6) destroyed but gets NO cell (immediately safe)
    assert (8, 6) not in cell_coords
    assert (9, 6) not in cell_coords
    # Grid should now be EMPTY at (8,6)
    assert grid[6 * MAP_COLS + 8] == TILE_EMPTY


def test_explosion_covers_at_center():
    # At tile center, exactly on fire tile → covered (≥ 2/3)
    cells = [{'tile_x': 3, 'tile_y': 3, 'ttl_ticks': SPARK_TICKS}]
    assert explosion_covers(cells, 3 * MILLITILE, 3 * MILLITILE) is True


def test_explosion_covers_lenient_edge():
    # Player at x=3333 mt (offset +333 from tile center 3000)
    # Flame only on tile (3,3). Overlap width = 1000 - 333 = 667 mt
    # Area = 667 * 1000 = 667000 mt²
    # Threshold = 2/3 * 1000000 = 666667 mt²
    # 667000 >= 666667 → COVERED
    cells = [{'tile_x': 3, 'tile_y': 3, 'ttl_ticks': SPARK_TICKS}]
    assert explosion_covers(cells, 3 * MILLITILE + 333, 3 * MILLITILE) is True


def test_explosion_covers_half_body_safe():
    # Player at x=3334 mt (offset +334 from tile center 3000)
    # Flame only on tile (3,3). Overlap width = 1000 - 334 = 666 mt
    # Area = 666 * 1000 = 666000 mt²  < 666667 → SAFE
    cells = [{'tile_x': 3, 'tile_y': 3, 'ttl_ticks': SPARK_TICKS}]
    assert explosion_covers(cells, 3 * MILLITILE + 334, 3 * MILLITILE) is False
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_explosion.py -v 2>&1 | head -5
```

Expected: `ImportError`

- [ ] **Step 3: 實作 rl/env/bomb.py**

```python
# rl/env/bomb.py
"""BombState + placement logic. Ported from client/src/sim/Bomb.ts."""
from rl.env.constants import FUSE_TICKS
from rl.env.types import ACTION_BOMB


def create_bomb(owner_slot: int, tile_x: int, tile_y: int, fire: int) -> dict:
    return {
        'owner_slot': owner_slot,
        'tile_x': tile_x,
        'tile_y': tile_y,
        'fuse_ticks': FUSE_TICKS,
        'fire': fire,
    }


def bomb_at(bombs: list[dict], tx: int, ty: int) -> dict | None:
    for b in bombs:
        if b['tile_x'] == tx and b['tile_y'] == ty:
            return b
    return None


def bomb_pressed_edge(prev_action: int, cur_action: int) -> bool:
    return (cur_action & ACTION_BOMB) != 0 and (prev_action & ACTION_BOMB) == 0


def try_place_bomb(
    bombs: list[dict], player: dict, tile_x: int, tile_y: int
) -> dict | None:
    if not player['alive'] or player['trapped']:
        return None
    if player['active_bombs'] >= player['cannon']:
        return None
    if bomb_at(bombs, tile_x, tile_y) is not None:
        return None
    player['active_bombs'] += 1
    return create_bomb(player['slot'], tile_x, tile_y, player['fire'])
```

- [ ] **Step 4: 實作 rl/env/explosion.py**

逐行對齊 `client/src/sim/Explosion.ts`：

```python
# rl/env/explosion.py
"""
Explosion (melt-flow) processing + lenient hitbox.
Ported from client/src/sim/Explosion.ts.
"""
import numpy as np
from rl.env.constants import (
    MILLITILE, SPARK_TICKS, ITEM_DROP_RATE, MAP_COLS, MAP_ROWS,
    HIT_COVER_NUM, HIT_COVER_DEN,
)
from rl.env.types import (
    TILE_HARD, TILE_SOFT, TILE_PUSH, TILE_EMPTY,
    is_destructible_brick,
    ITEM_FIRE, ITEM_SPEED, ITEM_CANNON,
)
from rl.env.prng import prng_float, prng_int
from rl.env.player import tile_of  # canonical tile_of — do NOT redefine here

# Fixed arm processing order: UP, DOWN, LEFT, RIGHT
_ARM_DELTAS = [(0, -1), (0, 1), (-1, 0), (1, 0)]


def _in_bounds(x: int, y: int) -> bool:
    return 0 <= x < MAP_COLS and 0 <= y < MAP_ROWS


def _idx(x: int, y: int) -> int:
    return y * MAP_COLS + x


def explosion_at(cells: list[dict], tx: int, ty: int) -> bool:
    for c in cells:
        if c['tile_x'] == tx and c['tile_y'] == ty:
            return True
    return False


def process_detonations(
    grid: np.ndarray, bombs: list[dict], prng: int
) -> dict:
    """
    Detonate all bombs with fuse_ticks <= 0 (including chains).
    MUTATES grid (caller passes tick-start clone). Returns result dict.
    Mirrors processDetonations in Explosion.ts.
    """
    detonated = [False] * len(bombs)
    queue: list[int] = []
    for i, b in enumerate(bombs):
        if b['fuse_ticks'] <= 0:
            detonated[i] = True
            queue.append(i)

    # Tick-start grid snapshot: blast arms read THIS, not the mutating grid.
    start_grid = grid.copy()

    cells: list[dict] = []
    items: list[dict] = []
    detonated_owners: list[int] = []
    p = prng

    q_idx = 0
    while q_idx < len(queue):
        bi = queue[q_idx]
        q_idx += 1
        bomb = bombs[bi]
        detonated_owners.append(bomb['owner_slot'])
        cells.append({'tile_x': bomb['tile_x'], 'tile_y': bomb['tile_y'], 'ttl_ticks': SPARK_TICKS})

        for (dx, dy) in _ARM_DELTAS:
            for step in range(1, bomb['fire'] + 1):
                tx = bomb['tile_x'] + dx * step
                ty = bomb['tile_y'] + dy * step
                if not _in_bounds(tx, ty):
                    break
                cell = _idx(tx, ty)
                if start_grid[cell] == TILE_HARD:
                    break
                if is_destructible_brick(start_grid[cell]):
                    # Destroy only once (if still destructible in live grid)
                    if is_destructible_brick(grid[cell]):
                        grid[cell] = TILE_EMPTY
                        roll, p = prng_float(p)
                        if roll < ITEM_DROP_RATE:
                            kind_v, p = prng_int(p, 0, 2)
                            items.append({'tile_x': tx, 'tile_y': ty, 'kind': kind_v})
                    break  # arm stops at destructible brick, NO cell here
                # Empty tile: chain any undetonated bomb here, then continue arm
                for j, other in enumerate(bombs):
                    if not detonated[j] and other['tile_x'] == tx and other['tile_y'] == ty:
                        detonated[j] = True
                        queue.append(j)
                        break
                cells.append({'tile_x': tx, 'tile_y': ty, 'ttl_ticks': SPARK_TICKS})

    surviving_bombs = [b for i, b in enumerate(bombs) if not detonated[i]]
    return {
        'bombs': surviving_bombs,
        'cells': cells,
        'items': items,
        'detonated_owners': detonated_owners,
        'prng': p,
    }


def explosion_covers(cells: list[dict], pos_x: int, pos_y: int) -> bool:
    """
    True when player body (1-tile box centred on pos_x,pos_y) is ≥ 2/3 covered.
    Mirrors explosionCovers in Explosion.ts — integer arithmetic only.
    tile_of imported from player.py (canonical definition, not redefined here).
    """
    tx = tile_of(pos_x)
    ty = tile_of(pos_y)
    ox = pos_x - tx * MILLITILE
    oy = pos_y - ty * MILLITILE
    sx = 1 if ox >= 0 else -1
    sy = 1 if oy >= 0 else -1
    area = 0
    for nx in [0, sx]:
        ovx = MILLITILE - abs(ox - nx * MILLITILE)
        if ovx <= 0:
            continue
        for ny in [0, sy]:
            ovy = MILLITILE - abs(oy - ny * MILLITILE)
            if ovy > 0 and explosion_at(cells, tx + nx, ty + ny):
                area += ovx * ovy
    return area * HIT_COVER_DEN >= HIT_COVER_NUM * MILLITILE * MILLITILE
```

- [ ] **Step 5: 確認測試通過**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_explosion.py -v
```

Expected: `7 passed`

- [ ] **Step 6: Commit**

```bash
git add rl/env/bomb.py rl/env/explosion.py rl/tests/test_explosion.py && git commit -m "feat(rl): bomb + explosion + lenient hitbox (Task 5)"
```

---

## Task 6：Shell（困住/救援）+ Items + Sudden Death

**Files:**
- Create: `rl/env/item.py`
- Create: `rl/env/shell.py`
- Create: `rl/env/sudden_death.py`
- Create: `rl/tests/test_shell.py`
- Create: `rl/tests/test_sudden_death.py`

- [ ] **Step 1: 寫 test_shell.py（先失敗）**

```python
# rl/tests/test_shell.py
from rl.env.shell import trap_player, step_shells
from rl.env.player import create_player, tile_of
from rl.env.constants import MILLITILE, TRAPPED_TICKS, RESCUE_DIST_MT


def _p(slot, tx, ty, team=None):
    p = create_player(slot, tx, ty, team=team if team is not None else slot)
    return p


def test_trap_snaps_to_center():
    p = _p(0, 3, 3)
    p['pos_x'] = 3400  # off-center
    trap_player(p)
    assert p['trapped'] is True
    assert p['pos_x'] == 3000  # snapped to tile center
    assert p['trapped_ticks'] == TRAPPED_TICKS


def test_rescue_by_teammate():
    victim = _p(0, 3, 3, team=0)
    trap_player(victim)
    rescuer = _p(1, 3, 3, team=0)  # same team, same tile
    step_shells([victim, rescuer])
    assert victim['trapped'] is False
    assert victim['alive'] is True


def test_enemy_breaks_shell():
    victim = _p(0, 3, 3, team=0)
    trap_player(victim)
    enemy = _p(1, 3, 3, team=1)  # different team
    step_shells([victim, enemy])
    assert victim['trapped'] is False
    assert victim['alive'] is False


def test_rescue_priority_over_enemy():
    victim = _p(0, 3, 3, team=0)
    trap_player(victim)
    rescuer = _p(1, 3, 3, team=0)
    enemy   = _p(2, 3, 3, team=1)
    step_shells([victim, rescuer, enemy])
    # Rescue wins (priority per Shell.ts)
    assert victim['alive'] is True
    assert victim['trapped'] is False


def test_timeout_eliminates():
    victim = _p(0, 3, 3)
    trap_player(victim)
    victim['trapped_ticks'] = 1
    step_shells([victim])
    assert victim['alive'] is False
```

- [ ] **Step 2: 寫 test_sudden_death.py（先失敗）**

```python
# rl/tests/test_sudden_death.py
import numpy as np
from rl.env.sudden_death import SPIRAL_ORDER, hardened_count, step_sudden_death
from rl.env.map_gen import generate_map
from rl.env.player import create_player
from rl.env.constants import (
    MAP_COLS, MAP_ROWS, SUDDEN_DEATH_START_TICK, SUDDEN_DEATH_TILE_INTERVAL
)
from rl.env.types import TILE_HARD


def test_spiral_covers_all_tiles():
    assert len(SPIRAL_ORDER) == MAP_COLS * MAP_ROWS


def test_spiral_starts_at_corner():
    assert SPIRAL_ORDER[0] == (0, 0)


def test_hardened_count_before_start():
    assert hardened_count(SUDDEN_DEATH_START_TICK - 1) == 0


def test_hardened_count_at_start():
    assert hardened_count(SUDDEN_DEATH_START_TICK) == 1


def test_hardened_count_interval():
    tick = SUDDEN_DEATH_START_TICK + SUDDEN_DEATH_TILE_INTERVAL
    assert hardened_count(tick) == 2


def test_step_sudden_death_hardens_tile():
    grid = np.zeros(MAP_ROWS * MAP_COLS, dtype=np.uint8)
    players = []
    step_sudden_death(grid, players, SUDDEN_DEATH_START_TICK)
    x, y = SPIRAL_ORDER[0]
    assert grid[y * MAP_COLS + x] == TILE_HARD


def test_step_sudden_death_crushes_player():
    grid = np.zeros(MAP_ROWS * MAP_COLS, dtype=np.uint8)
    x, y = SPIRAL_ORDER[0]
    p = create_player(slot=0, tile_x=x, tile_y=y)
    step_sudden_death(grid, [p], SUDDEN_DEATH_START_TICK)
    assert p['alive'] is False
```

- [ ] **Step 3: 確認兩個測試檔都失敗**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_shell.py rl/tests/test_sudden_death.py -v 2>&1 | head -10
```

Expected: `ImportError`

- [ ] **Step 4: 實作 rl/env/item.py**

```python
# rl/env/item.py
"""ItemState + applyItem. Ported from client/src/sim/Item.ts."""
from rl.env.constants import (
    PLAYER_MAX_FIRE, PLAYER_MAX_CANNON, SPEED_BONUS_CAP, SPEED_BONUS_PER_ITEM
)
from rl.env.types import ITEM_FIRE, ITEM_SPEED, ITEM_CANNON


def apply_item(player: dict, kind: int) -> None:
    """Apply a picked-up item to the player. MUTATES player dict."""
    if kind == ITEM_FIRE:
        player['fire'] = min(player['fire'] + 1, PLAYER_MAX_FIRE)
    elif kind == ITEM_SPEED:
        # +1.0 tiles/s = +10 tenths; cap = 3.0 tiles/s = 30 tenths
        player['speed_bonus_tenths'] = min(
            player['speed_bonus_tenths'] + 10,
            round(SPEED_BONUS_CAP / SPEED_BONUS_PER_ITEM) * 10  # 30
        )
    elif kind == ITEM_CANNON:
        player['cannon'] = min(player['cannon'] + 1, PLAYER_MAX_CANNON)
```

- [ ] **Step 5: 實作 rl/env/shell.py**

逐行對齊 `client/src/sim/Shell.ts`：

```python
# rl/env/shell.py
"""Sugar shell (trap/rescue) logic. Ported from client/src/sim/Shell.ts."""
from rl.env.constants import MILLITILE, TRAPPED_TICKS, RESCUE_DIST_MT
from rl.env.player import tile_of


def _within_dist(ax, ay, bx, by, dist_mt: int) -> bool:
    dx = ax - bx
    dy = ay - by
    return dx * dx + dy * dy <= dist_mt * dist_mt


def trap_player(player: dict) -> None:
    """Seal player in a sugar shell; snaps to tile center. MUTATES."""
    if not player['alive'] or player['trapped']:
        return
    player['trapped'] = True
    player['trapped_ticks'] = TRAPPED_TICKS
    player['pos_x'] = tile_of(player['pos_x']) * MILLITILE
    player['pos_y'] = tile_of(player['pos_y']) * MILLITILE


def _break_shell(player: dict) -> None:
    player['trapped'] = False
    player['trapped_ticks'] = 0
    player['alive'] = False


def step_shells(players: list[dict]) -> None:
    """Per-tick shell pass. MUTATES player dicts. Mirrors stepShells in Shell.ts."""
    for p in players:
        if not p['alive'] or not p['trapped']:
            continue
        # Phase A1: same-team rescue (priority)
        rescued = False
        for q in players:
            if q is p or not q['alive'] or q['trapped']:
                continue
            if q['team'] != p['team']:
                continue
            if _within_dist(p['pos_x'], p['pos_y'], q['pos_x'], q['pos_y'], RESCUE_DIST_MT):
                p['trapped'] = False
                p['trapped_ticks'] = 0
                rescued = True
                break
        if rescued:
            continue
        # Phase A2: enemy contact → instant break
        for q in players:
            if q is p or not q['alive'] or q['trapped']:
                continue
            if q['team'] == p['team']:
                continue
            if _within_dist(p['pos_x'], p['pos_y'], q['pos_x'], q['pos_y'], RESCUE_DIST_MT):
                _break_shell(p)
                break
    # Phase B: age timers
    for p in players:
        if not p['alive'] or not p['trapped']:
            continue
        p['trapped_ticks'] -= 1
        if p['trapped_ticks'] <= 0:
            _break_shell(p)
```

- [ ] **Step 6: 實作 rl/env/sudden_death.py**

逐行對齊 `client/src/sim/SuddenDeath.ts`：

```python
# rl/env/sudden_death.py
"""Sudden death spiral. Ported from client/src/sim/SuddenDeath.ts. PRNG-free."""
import numpy as np
from rl.env.constants import (
    MAP_COLS, MAP_ROWS,
    SUDDEN_DEATH_START_TICK, SUDDEN_DEATH_TILE_INTERVAL,
)
from rl.env.types import TILE_HARD
from rl.env.player import tile_of


def _build_spiral() -> list[tuple[int, int]]:
    """Inward spiral over the whole 15×13 grid, outermost ring first, clockwise."""
    order: list[tuple[int, int]] = []
    top, bottom, left, right = 0, MAP_ROWS - 1, 0, MAP_COLS - 1
    while top <= bottom and left <= right:
        for x in range(left, right + 1):
            order.append((x, top))
        top += 1
        for y in range(top, bottom + 1):
            order.append((right, y))
        right -= 1
        if top <= bottom:
            for x in range(right, left - 1, -1):
                order.append((x, bottom))
            bottom -= 1
        if left <= right:
            for y in range(bottom, top - 1, -1):
                order.append((left, y))
            left += 1
    return order


SPIRAL_ORDER: list[tuple[int, int]] = _build_spiral()


def hardened_count(tick: int) -> int:
    if tick < SUDDEN_DEATH_START_TICK:
        return 0
    n = (tick - SUDDEN_DEATH_START_TICK) // SUDDEN_DEATH_TILE_INTERVAL + 1
    return min(n, len(SPIRAL_ORDER))


def step_sudden_death(grid: np.ndarray, players: list[dict], tick: int) -> None:
    """Harden this tick's spiral tiles and crush players on them. MUTATES."""
    to   = hardened_count(tick)
    from_ = hardened_count(tick - 1)
    for i in range(from_, to):
        x, y = SPIRAL_ORDER[i]
        grid[y * MAP_COLS + x] = TILE_HARD
        for p in players:
            if p['alive'] and tile_of(p['pos_x']) == x and tile_of(p['pos_y']) == y:
                p['alive'] = False
                p['trapped'] = False
                p['trapped_ticks'] = 0
```

- [ ] **Step 7: 確認測試通過**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_shell.py rl/tests/test_sudden_death.py -v
```

Expected: `12 passed`

- [ ] **Step 8: Commit**

```bash
git add rl/env/item.py rl/env/shell.py rl/env/sudden_death.py \
        rl/tests/test_shell.py rl/tests/test_sudden_death.py \
  && git commit -m "feat(rl): shell/rescue, items, sudden death spiral (Task 6)"
```

---

## Task 7：Sim Core（SimState + tick 迴圈）

**Files:**
- Create: `rl/env/sim.py`
- Create: `rl/tests/test_sim.py`

- [ ] **Step 1: 寫 test_sim.py（先失敗）**

```python
# rl/tests/test_sim.py
import pytest
from rl.env.sim import create_initial_state, tick
from rl.env.constants import MILLITILE, FUSE_TICKS, MAP_COLS
from rl.env.types import PHASE_PLAYING, PHASE_OVER, NO_INPUT, InputFrame, ACTION_BOMB, DIR_NONE


def test_initial_state_phase():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    assert state['phase'] == PHASE_PLAYING
    assert state['tick'] == 0
    assert len(state['players']) == 2


def test_tick_increments():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    inputs = [NO_INPUT, NO_INPUT]
    state2 = tick(state, inputs)
    assert state2['tick'] == 1


def test_bomb_fuse_decrements():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    # Place a bomb manually
    p0 = state['players'][0]
    tx = p0['pos_x'] // MILLITILE
    ty = p0['pos_y'] // MILLITILE
    bomb_input = InputFrame(dir=DIR_NONE, action=ACTION_BOMB)
    state2 = tick(state, [bomb_input, NO_INPUT])
    assert len(state2['bombs']) == 1
    assert state2['bombs'][0]['fuse_ticks'] == FUSE_TICKS - 1


def test_game_ends_when_one_player_survives():
    # One player dead, one alive → OVER
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    state['players'][1]['alive'] = False
    state2 = tick(state, [NO_INPUT, NO_INPUT])
    assert state2['phase'] == PHASE_OVER


def test_immutability():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    state2 = tick(state, [NO_INPUT, NO_INPUT])
    # Original state unmodified
    assert state['tick'] == 0
    assert state2['tick'] == 1
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_sim.py -v 2>&1 | head -5
```

Expected: `ImportError`

- [ ] **Step 3: 實作 rl/env/sim.py**

逐行對齊 `client/src/sim/Sim.ts` tick 系統順序（1–10 步）：

```python
# rl/env/sim.py
"""
SimState + fixed-order tick(). Ported from client/src/sim/Sim.ts.
Tick system order (do NOT reorder — determinism contract):
  1. players: resolve input & move
  2. bomb placement from action edges
  3. fuse decrement; detonations → explosion cells, brick destruction, item drops
  4. explosion-cell hits: trap players
  5. item pickups
  6. shells: rescue then timers → elimination
  7. age & cull explosion cells
  8. sudden death
  9. win check → phase OVER
 10. tick + 1
"""
import copy
import numpy as np
from rl.env.constants import (
    MILLITILE, FUSE_TICKS, SPARK_TICKS, MATCH_MAX_TICKS,
    MAP_COLS, MAP_ROWS,
    DEFAULT_MOVE_SPEED, DEFAULT_CORNER_ASSIST, DEFAULT_INPUT_BUFFER_MS, TICK_HZ,
)
from rl.env.types import (
    PHASE_PLAYING, PHASE_OVER,
    DIR_NONE, DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT,
    ACTION_BOMB,
    InputFrame, NO_INPUT,
    TILE_EMPTY, TILE_HARD,
)
from rl.env.map_gen import generate_map, map_spawns
from rl.env.player import (
    create_player, step_entity, tile_of,
    player_speed_mt_per_tick,
)
from rl.env.bomb import bomb_at, bomb_pressed_edge, try_place_bomb
from rl.env.explosion import process_detonations, explosion_covers
from rl.env.item import apply_item
from rl.env.shell import step_shells, trap_player
from rl.env.sudden_death import step_sudden_death

_MOVE_SPEED_MT = round(DEFAULT_MOVE_SPEED * MILLITILE)   # 5000
_CORNER_ASSIST_MT = round(DEFAULT_CORNER_ASSIST * MILLITILE)  # 250
_INPUT_BUFFER_TICKS = round(DEFAULT_INPUT_BUFFER_MS / (1000 / TICK_HZ))  # 7


def create_initial_state(seed: int, map_kind: str = 'classic', num_players: int = 4) -> dict:
    grid, prng = generate_map(seed, map_kind)
    spawns = map_spawns(map_kind)
    players = []
    for i in range(num_players):
        sx, sy = spawns[i % len(spawns)]
        players.append(create_player(slot=i, tile_x=sx, tile_y=sy, team=i))
    return {
        'tick': 0,
        'phase': PHASE_PLAYING,
        'prng': prng,
        'map_kind': map_kind,
        'grid': grid,
        'players': players,
        'bombs': [],
        'explosions': [],
        'items': [],
    }


def _is_open(grid: np.ndarray, bombs: list[dict], x: int, y: int) -> bool:
    if x < 0 or x >= MAP_COLS or y < 0 or y >= MAP_ROWS:
        return False
    if grid[y * MAP_COLS + x] != TILE_EMPTY:
        return False
    return bomb_at(bombs, x, y) is None


def tick(state: dict, inputs: list[InputFrame]) -> dict:
    """Advance state by one tick. Returns a NEW state (does not mutate input)."""
    s = copy.deepcopy(state)
    grid = s['grid']
    players = s['players']
    bombs = s['bombs']
    explosions = s['explosions']
    items = s['items']
    prng = s['prng']

    # ── Step 1: resolve input & move ─────────────────────────────────────────
    for i, p in enumerate(players):
        if not p['alive'] or p['trapped']:
            continue
        inp = inputs[i] if i < len(inputs) else NO_INPUT
        speed = player_speed_mt_per_tick(_MOVE_SPEED_MT, p['speed_bonus_tenths'])
        def open_fn(ax, bx, _g=grid, _b=bombs):
            return _is_open(_g, _b, ax, bx)
        d = inp.dir
        if d != DIR_NONE:
            nx, ny, moved = step_entity(open_fn, p['pos_x'], p['pos_y'], d, speed, _CORNER_ASSIST_MT)
            if moved:
                p['pos_x'] = nx
                p['pos_y'] = ny
                p['facing'] = d

    # ── Step 2: bomb placement ────────────────────────────────────────────────
    new_bombs = list(bombs)
    for i, p in enumerate(players):
        inp = inputs[i] if i < len(inputs) else NO_INPUT
        if bomb_pressed_edge(p['prev_action'], inp.action):
            tx = tile_of(p['pos_x'])
            ty = tile_of(p['pos_y'])
            b = try_place_bomb(new_bombs, p, tx, ty)
            if b is not None:
                new_bombs.append(b)
        p['prev_action'] = inp.action

    # ── Step 3: fuse decrement + detonations ─────────────────────────────────
    for b in new_bombs:
        b['fuse_ticks'] -= 1

    result = process_detonations(grid, new_bombs, prng)
    bombs_after = result['bombs']
    new_cells = result['cells']
    new_items = result['items']
    prng = result['prng']
    # Credit detonated owners
    detonated_owners = result['detonated_owners']
    owner_counts: dict[int, int] = {}
    for owner in detonated_owners:
        owner_counts[owner] = owner_counts.get(owner, 0) + 1
    for p in players:
        if p['slot'] in owner_counts:
            p['active_bombs'] = max(0, p['active_bombs'] - owner_counts[p['slot']])

    all_cells = [c for c in explosions if c['ttl_ticks'] > 0] + new_cells

    # ── Step 4: explosion hits → trap players ────────────────────────────────
    for p in players:
        if not p['alive'] or p['trapped']:
            continue
        if explosion_covers(all_cells, p['pos_x'], p['pos_y']):
            trap_player(p)

    # ── Step 5: item pickups ──────────────────────────────────────────────────
    items_remaining = list(items) + new_items
    items_after = []
    for it in items_remaining:
        claimed = False
        for p in players:
            if p['alive'] and not p['trapped']:
                if tile_of(p['pos_x']) == it['tile_x'] and tile_of(p['pos_y']) == it['tile_y']:
                    apply_item(p, it['kind'])
                    claimed = True
                    break
        if not claimed:
            items_after.append(it)

    # ── Step 6: shells ────────────────────────────────────────────────────────
    step_shells(players)

    # ── Step 7: age & cull explosion cells ───────────────────────────────────
    explosions_after = []
    for c in all_cells:
        c['ttl_ticks'] -= 1
        if c['ttl_ticks'] > 0:
            explosions_after.append(c)

    # ── Step 8: sudden death ──────────────────────────────────────────────────
    step_sudden_death(grid, players, s['tick'] + 1)  # applies at new tick

    # ── Step 9: win check ─────────────────────────────────────────────────────
    alive_teams = {p['team'] for p in players if p['alive']}
    if len(alive_teams) <= 1 or s['tick'] + 1 >= MATCH_MAX_TICKS:
        phase = PHASE_OVER
    else:
        phase = PHASE_PLAYING

    return {
        'tick': s['tick'] + 1,
        'phase': phase,
        'prng': prng,
        'map_kind': s['map_kind'],
        'grid': grid,
        'players': players,
        'bombs': bombs_after,
        'explosions': explosions_after,
        'items': items_after,
    }
```

- [ ] **Step 4: 確認測試通過**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_sim.py -v
```

Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add rl/env/sim.py rl/tests/test_sim.py && git commit -m "feat(rl): SimState + tick loop (Task 7)"
```

---

## Task 8：Phase 0 決定性關卡

**Files:**
- Create: `tools/sim-runner/src/gen-phase0-scenarios.ts`
- Create: `rl/tests/fixtures/phase0_scenarios.json`（由 TS 腳本生成）
- Create: `rl/tests/test_phase0_determinism.py`

- [ ] **Step 1: 寫 TS 夾具生成腳本**

```typescript
// tools/sim-runner/src/gen-phase0-scenarios.ts
/**
 * Generate Phase 0 determinism fixtures.
 * Runs 5 scripted scenarios with fixed inputs; outputs (seed, map_kind, winner_slot, duration_ticks).
 * Usage: npx tsx tools/sim-runner/src/gen-phase0-scenarios.ts > rl/tests/fixtures/phase0_scenarios.json
 */
import { createInitialState, tick } from '../../../client/src/sim/Sim';
import { NO_INPUT } from '../../../client/src/sim/InputBuffer';
import { ActionFlags, Direction, GamePhase } from '../../../shared/types';

interface Scenario {
  seed: number;
  map_kind: string;
  scripted_inputs: Array<{ dir: number; action: number }[]>;  // per-tick, per-slot
  expected_winner_slot: number | null;
  expected_duration_ticks: number;
}

function runScenario(
  seed: number,
  mapKind: string,
  numPlayers: number,
  inputScript: (tick: number, slot: number) => { dir: number; action: number },
): { winner_slot: number | null; duration_ticks: number } {
  let state = createInitialState(seed, numPlayers, { mapKind });
  let t = 0;
  while (state.phase === GamePhase.PLAYING && t < 10800) {
    const inputs = state.players.map((_, i) => inputScript(t, i));
    state = tick(state, inputs);
    t++;
  }
  const alive = state.players.filter(p => p.alive);
  const winner_slot = alive.length === 1 ? alive[0]!.slot : null;
  return { winner_slot, duration_ticks: state.tick };
}

const SCENARIOS = [
  // Scenario 0: All players stand still — game runs to match cap (sudden death)
  {
    seed: 0, map_kind: 'classic', num_players: 2,
    input_fn: (_t: number, _slot: number) => ({ dir: 0, action: 0 }),
  },
  // Scenario 1: Player 0 places bomb tick 0, both stand still
  {
    seed: 1, map_kind: 'classic', num_players: 2,
    input_fn: (t: number, slot: number) => ({
      dir: 0,
      action: (t === 0 && slot === 0) ? ActionFlags.BOMB : 0,
    }),
  },
  // Scenario 2: pirate map, players move toward each other
  {
    seed: 2, map_kind: 'pirate', num_players: 2,
    input_fn: (_t: number, slot: number) => ({
      dir: slot === 0 ? Direction.RIGHT : Direction.LEFT,
      action: 0,
    }),
  },
  // Scenario 3: All 4 players, classic, drop bombs tick 5
  {
    seed: 3, map_kind: 'classic', num_players: 4,
    input_fn: (t: number, _slot: number) => ({
      dir: 0,
      action: t === 5 ? ActionFlags.BOMB : 0,
    }),
  },
  // Scenario 4: chain explosion (player 0 drops bomb at tick 0; player 1 at tick 1, adjacent)
  {
    seed: 4, map_kind: 'classic', num_players: 2,
    input_fn: (t: number, slot: number) => ({
      dir: t < 10 ? (slot === 0 ? Direction.RIGHT : Direction.LEFT) : 0,
      action: t === 30 ? ActionFlags.BOMB : 0,
    }),
  },
];

const results = SCENARIOS.map(({ seed, map_kind, num_players, input_fn }) => {
  const res = runScenario(seed, map_kind, num_players, input_fn);
  return { seed, map_kind, num_players, ...res };
});

process.stdout.write(JSON.stringify(results, null, 2));
```

- [ ] **Step 2: 生成夾具 JSON**

```bash
cd /home/m2553/repo/10-choccus && npx tsx tools/sim-runner/src/gen-phase0-scenarios.ts > rl/tests/fixtures/phase0_scenarios.json
```

Expected: 無錯誤，`rl/tests/fixtures/phase0_scenarios.json` 包含 5 個物件的陣列。

```bash
python3 -c "import json; d=json.load(open('rl/tests/fixtures/phase0_scenarios.json')); print(len(d), 'scenarios')"
```

Expected: `5 scenarios`

- [ ] **Step 3: 寫 test_phase0_determinism.py（先失敗）**

```python
# rl/tests/test_phase0_determinism.py
"""
Phase 0 gate: Python sim must reproduce TS sim outcomes for all scripted scenarios.
"""
import json
import pytest
from pathlib import Path
from rl.env.sim import create_initial_state, tick
from rl.env.types import PHASE_PLAYING, InputFrame, DIR_NONE, DIR_RIGHT, DIR_LEFT, ACTION_BOMB

FIXTURES = json.loads(
    (Path(__file__).parent / 'fixtures' / 'phase0_scenarios.json').read_text()
)

_DIR_MAP = {0: DIR_NONE, 1: 1, 2: 2, 4: 4, 8: 8}  # Direction values match TS


def _run_python_scenario(scenario: dict) -> dict:
    """Replay the same scripted inputs in the Python sim."""
    seed = scenario['seed']
    map_kind = scenario['map_kind']
    num_players = scenario['num_players']
    state = create_initial_state(seed=seed, map_kind=map_kind, num_players=num_players)

    # Reconstruct the same input function based on scenario index
    idx = FIXTURES.index(scenario)
    def input_fn(t: int, slot: int) -> InputFrame:
        if idx == 0:
            return InputFrame(dir=DIR_NONE, action=0)
        elif idx == 1:
            return InputFrame(dir=DIR_NONE, action=ACTION_BOMB if t == 0 and slot == 0 else 0)
        elif idx == 2:
            return InputFrame(dir=DIR_RIGHT if slot == 0 else DIR_LEFT, action=0)
        elif idx == 3:
            return InputFrame(dir=DIR_NONE, action=ACTION_BOMB if t == 5 else 0)
        else:  # idx == 4
            if t < 10:
                d = DIR_RIGHT if slot == 0 else DIR_LEFT
            else:
                d = DIR_NONE
            return InputFrame(dir=d, action=ACTION_BOMB if t == 30 else 0)

    t = 0
    while state['phase'] == PHASE_PLAYING and t < 10800:
        inputs = [input_fn(t, i) for i in range(num_players)]
        state = tick(state, inputs)
        t += 1

    alive = [p for p in state['players'] if p['alive']]
    winner_slot = alive[0]['slot'] if len(alive) == 1 else None
    return {'winner_slot': winner_slot, 'duration_ticks': state['tick']}


@pytest.mark.parametrize("scenario", FIXTURES)
def test_matches_ts_outcome(scenario):
    result = _run_python_scenario(scenario)
    assert result['winner_slot'] == scenario['winner_slot'], (
        f"Seed {scenario['seed']}: winner mismatch "
        f"Python={result['winner_slot']} TS={scenario['winner_slot']}"
    )
    assert result['duration_ticks'] == scenario['duration_ticks'], (
        f"Seed {scenario['seed']}: duration mismatch "
        f"Python={result['duration_ticks']} TS={scenario['duration_ticks']}"
    )
```

- [ ] **Step 4: 確認測試先失敗（Python sim 可能尚未完全正確）**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_phase0_determinism.py -v
```

若有失敗：對照輸出的 seed + winner mismatch，在 `rl/env/sim.py` 修正對應的 tick 步驟，直到全部通過。常見問題：

- `step_sudden_death` 的 tick 傳入值是 `s['tick'] + 1`（新 tick）還是 `s['tick']`（當前 tick）——對齊 Sim.ts 第 8 步
- `bomb_pressed_edge` 需要 `p['prev_action']` 而不是 `inp.action`
- `explosion_covers` 的 `tile_of` 必須用半向上取整（`(mt + 500) // 1000`），不能用 `round()`

- [ ] **Step 5: 確認 Phase 0 關卡全過**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_phase0_determinism.py -v
```

Expected: `5 passed` — **Phase 0 關卡通過**

- [ ] **Step 6: Commit**

```bash
git add tools/sim-runner/src/gen-phase0-scenarios.ts \
        rl/tests/fixtures/phase0_scenarios.json \
        rl/tests/test_phase0_determinism.py \
  && git commit -m "feat(rl): Phase 0 determinism gate — 5 scenarios pass (Task 8)"
```

---

## Task 9：State Encoder（15×13×12 通道 + 9 scalars）

**Files:**
- Create: `rl/env/state_encoder.py`
- Create: `rl/tests/test_state_encoder.py`

- [ ] **Step 1: 寫 test_state_encoder.py（先失敗）**

```python
# rl/tests/test_state_encoder.py
import numpy as np
import pytest
from rl.env.sim import create_initial_state
from rl.env.state_encoder import encode_state
from rl.env.constants import MAP_ROWS, MAP_COLS


def test_grid_shape():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    grid, scalars = encode_state(state, slot=0)
    assert grid.shape == (MAP_ROWS, MAP_COLS, 12)
    assert grid.dtype == np.float32


def test_scalars_shape():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    _, scalars = encode_state(state, slot=0)
    assert scalars.shape == (9,)
    assert scalars.dtype == np.float32


def test_self_position_channel():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    grid, _ = encode_state(state, slot=0)
    p0 = state['players'][0]
    from rl.env.player import tile_of
    from rl.env.constants import MILLITILE
    tx = tile_of(p0['pos_x'])
    ty = tile_of(p0['pos_y'])
    # Channel 3 = self position
    assert grid[ty, tx, 3] == 1.0


def test_enemy_position_channel():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    grid, _ = encode_state(state, slot=0)
    p1 = state['players'][1]
    from rl.env.player import tile_of
    tx = tile_of(p1['pos_x'])
    ty = tile_of(p1['pos_y'])
    # Channel 4 = enemy positions
    assert grid[ty, tx, 4] == 1.0


def test_scalar_subtile_offsets():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    # At spawn (tile center), ox and oy should be 0
    _, scalars = encode_state(state, slot=0)
    assert scalars[7] == pytest.approx(0.0)  # self_ox
    assert scalars[8] == pytest.approx(0.0)  # self_oy


def test_grid_values_in_range():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    grid, scalars = encode_state(state, slot=0)
    assert grid.min() >= -1.0
    assert grid.max() <= 1.0
    assert scalars.min() >= -1.0
    assert scalars.max() <= 1.0
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_state_encoder.py -v 2>&1 | head -5
```

Expected: `ImportError`

- [ ] **Step 3: 實作 rl/env/state_encoder.py**

```python
# rl/env/state_encoder.py
"""
SimState dict → numpy arrays for Gymnasium observations.
Output: (grid: float32[13,15,12], scalars: float32[9])

Channels (15×13 each):
  0: hard walls (0/1)
  1: soft bricks (0/1)
  2: pushable crates (0/1)
  3: self position (0/1, tile-center rounded)
  4: enemy positions (0/1)
  5: bomb fuse timers (t_remaining/180)
  6: current flame cells (0/1)
  7: predicted explosion zones (0/1, based on in-flight bombs)
  8: items on ground (1=fire/3, 2=speed/3, 3=cannon/3)
  9: sudden-death hardened tiles (0/1)
 10: trapped players (0/1)
 11: time progress (tick/10800, same value all cells)

Scalars (9):
  0: self fire / 7
  1: self cannon / 6
  2: self speed_bonus_tenths / 30
  3: self active_bombs / 6
  4: alive enemy count / 3
  5: in sudden death period (0/1)
  6: push charge progress / 30
  7: self_ox = (pos_x mod 1000 - 500) / 500  ∈ [-1,1]
  8: self_oy = (pos_y mod 1000 - 500) / 500  ∈ [-1,1]
"""
import numpy as np
from rl.env.constants import (
    MAP_ROWS, MAP_COLS, MILLITILE, FUSE_TICKS,
    MATCH_MAX_TICKS, SUDDEN_DEATH_START_TICK,
    PLAYER_MAX_FIRE, PLAYER_MAX_CANNON, PUSH_CHARGE_TICKS,
)
from rl.env.types import TILE_HARD, TILE_SOFT, TILE_PUSH, ITEM_FIRE, ITEM_SPEED, ITEM_CANNON
from rl.env.player import tile_of
from rl.env.sudden_death import SPIRAL_ORDER, hardened_count


def _predicted_explosion_zones(bombs: list[dict], grid: np.ndarray) -> np.ndarray:
    """Mark all tiles a placed bomb could reach given its fire power."""
    ch = np.zeros((MAP_ROWS, MAP_COLS), dtype=np.float32)
    for b in bombs:
        bx, by = b['tile_x'], b['tile_y']
        ch[by, bx] = 1.0
        for dx, dy in [(0,-1),(0,1),(-1,0),(1,0)]:
            for step in range(1, b['fire'] + 1):
                tx, ty = bx + dx * step, by + dy * step
                if tx < 0 or tx >= MAP_COLS or ty < 0 or ty >= MAP_ROWS:
                    break
                tile = grid[ty * MAP_COLS + tx]
                if tile == TILE_HARD:
                    break
                ch[ty, tx] = 1.0
                if tile == TILE_SOFT or tile == TILE_PUSH:
                    break  # arm stops at destructible brick
    return ch


def encode_state(state: dict, slot: int) -> tuple[np.ndarray, np.ndarray]:
    """Encode SimState for agent `slot`. Returns (grid [13,15,12], scalars [9])."""
    grid_raw = state['grid']
    players = state['players']
    bombs = state['bombs']
    explosions = state['explosions']
    items = state['items']
    t = state['tick']

    ch = np.zeros((MAP_ROWS, MAP_COLS, 12), dtype=np.float32)

    # Ch 0-2: tile types
    for y in range(MAP_ROWS):
        for x in range(MAP_COLS):
            kind = grid_raw[y * MAP_COLS + x]
            if kind == TILE_HARD:
                ch[y, x, 0] = 1.0
            elif kind == TILE_SOFT:
                ch[y, x, 1] = 1.0
            elif kind == TILE_PUSH:
                ch[y, x, 2] = 1.0

    # Ch 3: self; Ch 4: enemies; Ch 10: trapped
    self_player = None
    for p in players:
        if not p['alive']:
            continue
        tx = tile_of(p['pos_x'])
        ty = tile_of(p['pos_y'])
        if p['slot'] == slot:
            self_player = p
            ch[ty, tx, 3] = 1.0
        else:
            ch[ty, tx, 4] = 1.0
        if p['trapped']:
            ch[ty, tx, 10] = 1.0

    # Ch 5: bomb fuse timers
    for b in bombs:
        ch[b['tile_y'], b['tile_x'], 5] = b['fuse_ticks'] / FUSE_TICKS

    # Ch 6: active flame cells
    for c in explosions:
        if 0 <= c['tile_y'] < MAP_ROWS and 0 <= c['tile_x'] < MAP_COLS:
            ch[c['tile_y'], c['tile_x'], 6] = 1.0

    # Ch 7: predicted explosion zones
    ch[:, :, 7] = _predicted_explosion_zones(bombs, grid_raw)

    # Ch 8: items on ground
    item_value = {ITEM_FIRE: 1/3, ITEM_SPEED: 2/3, ITEM_CANNON: 1.0}
    for it in items:
        ch[it['tile_y'], it['tile_x'], 8] = item_value.get(it['kind'], 0.0)

    # Ch 9: sudden death hardened tiles
    count = hardened_count(t)
    for i in range(count):
        x, y = SPIRAL_ORDER[i]
        ch[y, x, 9] = 1.0

    # Ch 11: time progress (constant plane)
    ch[:, :, 11] = t / MATCH_MAX_TICKS

    # Scalars
    in_sd = 1.0 if t >= SUDDEN_DEATH_START_TICK else 0.0
    alive_enemies = sum(1 for p in players if p['alive'] and p['slot'] != slot)

    if self_player is not None:
        pos_x = self_player['pos_x']
        pos_y = self_player['pos_y']
        ox = pos_x % MILLITILE - MILLITILE // 2   # center at 0
        oy = pos_y % MILLITILE - MILLITILE // 2
        scalars = np.array([
            self_player['fire'] / PLAYER_MAX_FIRE,         # 0
            self_player['cannon'] / PLAYER_MAX_CANNON,      # 1
            self_player['speed_bonus_tenths'] / 30.0,       # 2
            self_player['active_bombs'] / PLAYER_MAX_CANNON, # 3
            alive_enemies / 3.0,                            # 4
            in_sd,                                           # 5
            self_player['push_charge_ticks'] / PUSH_CHARGE_TICKS,  # 6
            ox / (MILLITILE // 2),                          # 7: self_ox ∈ [-1,1]
            oy / (MILLITILE // 2),                          # 8: self_oy ∈ [-1,1]
        ], dtype=np.float32)
    else:
        scalars = np.zeros(9, dtype=np.float32)

    return ch, scalars
```

- [ ] **Step 4: 確認測試通過**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_state_encoder.py -v
```

Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add rl/env/state_encoder.py rl/tests/test_state_encoder.py && git commit -m "feat(rl): state encoder 12ch + 9 scalars with sub-tile offsets (Task 9)"
```

---

## Task 10：Action Mask（BFS 安全濾網）

**Files:**
- Create: `rl/env/action_mask.py`
- Create: `rl/tests/test_action_mask.py`

- [ ] **Step 1: 寫 test_action_mask.py（先失敗）**

```python
# rl/tests/test_action_mask.py
import numpy as np
import pytest
from rl.env.sim import create_initial_state, tick
from rl.env.action_mask import compute_action_mask
from rl.env.types import NO_INPUT, InputFrame, ACTION_BOMB, DIR_NONE
from rl.env.constants import MILLITILE


def test_open_field_all_actions_allowed():
    state = create_initial_state(seed=0, map_kind='classic', num_players=1)
    mask = compute_action_mask(state, slot=0)
    assert mask.shape == (6,)
    assert mask.dtype == bool
    # In open field, at minimum stay(0) should be allowed
    assert mask[0] is True


def test_stay_always_allowed():
    state = create_initial_state(seed=0, map_kind='classic', num_players=1)
    mask = compute_action_mask(state, slot=0)
    assert mask[0] is True  # stay is always safe


def test_dead_player_mask_all_false():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    state['players'][0]['alive'] = False
    mask = compute_action_mask(state, slot=0)
    assert not any(mask)


def test_bomb_blocked_in_no_escape():
    """If placing a bomb leaves no escape route, bomb action must be masked."""
    # Create a fully walled-in state by placing HARD bricks around player
    import numpy as np
    from rl.env.types import TILE_HARD
    from rl.env.constants import MAP_COLS, MAP_ROWS
    state = create_initial_state(seed=0, map_kind='classic', num_players=1)
    p = state['players'][0]
    # Wall off all 4 neighbors
    from rl.env.player import tile_of
    tx = tile_of(p['pos_x'])
    ty = tile_of(p['pos_y'])
    grid = state['grid']
    for (dx, dy) in [(0,-1),(0,1),(-1,0),(1,0)]:
        nx, ny = tx+dx, ty+dy
        if 0 <= nx < MAP_COLS and 0 <= ny < MAP_ROWS:
            grid[ny * MAP_COLS + nx] = TILE_HARD
    mask = compute_action_mask(state, slot=0)
    assert mask[5] is False  # bomb is masked (no escape)
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_action_mask.py -v 2>&1 | head -5
```

Expected: `ImportError`

- [ ] **Step 3: 實作 rl/env/action_mask.py**

```python
# rl/env/action_mask.py
"""
Safety action mask: BFS to find at least one safe escape tile.
An action is safe if it leaves the player with at least one reachable tile
that has no active or imminent flame (active cells + in-fuse bombs).

Action indices: 0=stay, 1=up, 2=down, 3=left, 4=right, 5=place_bomb
"""
import numpy as np
from collections import deque
from rl.env.constants import (
    MAP_COLS, MAP_ROWS, MILLITILE, FUSE_TICKS, SPARK_TICKS
)
from rl.env.types import (
    TILE_HARD, TILE_SOFT, TILE_PUSH, TILE_EMPTY,
    DIR_NONE, DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT,
    ACTION_BOMB,
)
from rl.env.player import tile_of
from rl.env.bomb import bomb_at, try_place_bomb, create_bomb
from rl.env.explosion import explosion_at

_DIRECTIONS = [DIR_NONE, DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT]
_DIR_DELTAS = {
    DIR_NONE:  (0,  0),
    DIR_UP:    (0, -1),
    DIR_DOWN:  (0,  1),
    DIR_LEFT:  (-1, 0),
    DIR_RIGHT: (1,  0),
}


def _danger_set(explosions: list[dict], bombs: list[dict]) -> set[tuple[int,int]]:
    """Set of (tx,ty) that are currently or imminently dangerous."""
    danger: set[tuple[int,int]] = set()
    for c in explosions:
        danger.add((c['tile_x'], c['tile_y']))
    for b in bombs:
        # Mark bomb center + all arm tiles
        danger.add((b['tile_x'], b['tile_y']))
        for dx, dy in [(0,-1),(0,1),(-1,0),(1,0)]:
            for step in range(1, b['fire'] + 1):
                tx, ty = b['tile_x'] + dx * step, b['tile_y'] + dy * step
                if tx < 0 or tx >= MAP_COLS or ty < 0 or ty >= MAP_ROWS:
                    break
                danger.add((tx, ty))
    return danger


def _has_escape(
    start_tx: int, start_ty: int,
    grid: np.ndarray,
    bombs: list[dict],
    danger: set[tuple[int,int]],
    max_depth: int = 10,
) -> bool:
    """BFS from (start_tx, start_ty); returns True if any reachable tile is safe."""
    if (start_tx, start_ty) not in danger:
        return True  # current position already safe
    visited = {(start_tx, start_ty)}
    queue = deque([(start_tx, start_ty, 0)])
    while queue:
        cx, cy, depth = queue.popleft()
        if depth >= max_depth:
            continue
        for dx, dy in [(0,-1),(0,1),(-1,0),(1,0)]:
            nx, ny = cx + dx, cy + dy
            if (nx, ny) in visited:
                continue
            if nx < 0 or nx >= MAP_COLS or ny < 0 or ny >= MAP_ROWS:
                continue
            tile = grid[ny * MAP_COLS + nx]
            if tile == TILE_HARD or tile == TILE_SOFT or tile == TILE_PUSH:
                continue
            if bomb_at(bombs, nx, ny) is not None:
                continue
            visited.add((nx, ny))
            if (nx, ny) not in danger:
                return True
            queue.append((nx, ny, depth + 1))
    return False


def compute_action_mask(state: dict, slot: int) -> np.ndarray:
    """Returns bool[6] mask — True = action is safe for agent `slot`."""
    mask = np.zeros(6, dtype=bool)
    players = state['players']
    self_player = next((p for p in players if p['slot'] == slot), None)
    if self_player is None or not self_player['alive']:
        return mask

    grid = state['grid']
    bombs = state['bombs']
    explosions = state['explosions']
    danger = _danger_set(explosions, bombs)

    tx = tile_of(self_player['pos_x'])
    ty = tile_of(self_player['pos_y'])

    # Actions 0-4: movement directions
    for ai, direction in enumerate(_DIRECTIONS):
        dx, dy = _DIR_DELTAS[direction]
        ntx, nty = tx + dx, ty + dy
        # Clamp to grid
        ntx = max(0, min(MAP_COLS - 1, ntx))
        nty = max(0, min(MAP_ROWS - 1, nty))
        # Can we move there?
        if direction != DIR_NONE:
            tile = grid[nty * MAP_COLS + ntx]
            if tile in (TILE_HARD, TILE_SOFT, TILE_PUSH):
                ntx, nty = tx, ty  # blocked: stay at current tile
            elif bomb_at(bombs, ntx, nty) is not None:
                ntx, nty = tx, ty
        if _has_escape(ntx, nty, grid, bombs, danger):
            mask[ai] = True

    # Action 5: place bomb — safe only if escape route exists after placement
    if not self_player['trapped'] and self_player['active_bombs'] < self_player['cannon']:
        if bomb_at(bombs, tx, ty) is None:
            # Simulate placing bomb
            dummy_player = dict(self_player)
            dummy_bomb = create_bomb(slot, tx, ty, dummy_player['fire'])
            hypothetical_bombs = list(bombs) + [dummy_bomb]
            hyp_danger = _danger_set(explosions, hypothetical_bombs)
            if _has_escape(tx, ty, grid, hypothetical_bombs, hyp_danger):
                mask[5] = True

    return mask
```

- [ ] **Step 4: 確認測試通過**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_action_mask.py -v
```

Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add rl/env/action_mask.py rl/tests/test_action_mask.py && git commit -m "feat(rl): action mask BFS safety filter (Task 10)"
```

---

## Task 11：Gymnasium Wrapper + SPS 驗証

**Files:**
- Create: `rl/env/choccus_env.py`
- Create: `rl/tests/test_gymnasium_env.py`

- [ ] **Step 1: 安裝 Gymnasium**

```bash
cd /home/m2553/repo/10-choccus && pip install -r rl/requirements.txt
```

Expected: `Successfully installed gymnasium-0.29.1 ...`

- [ ] **Step 2: 寫 test_gymnasium_env.py（先失敗）**

```python
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
```

- [ ] **Step 3: 確認測試失敗**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_gymnasium_env.py -v 2>&1 | head -5
```

Expected: `ImportError`

- [ ] **Step 4: 實作 rl/env/choccus_env.py**

```python
# rl/env/choccus_env.py
"""
Gymnasium environment wrapping the Python Choccus sim.
Agent controls slot 0; opponents run a rule-based policy (random safe action).
"""
import numpy as np
import gymnasium as gym
from gymnasium import spaces
from rl.env.sim import create_initial_state, tick
from rl.env.state_encoder import encode_state
from rl.env.action_mask import compute_action_mask
from rl.env.constants import (
    MAP_ROWS, MAP_COLS, MATCH_MAX_TICKS, FUSE_TICKS,
    SUDDEN_DEATH_START_TICK,
)
from rl.env.types import (
    PHASE_OVER, PHASE_PLAYING,
    DIR_NONE, DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT, ACTION_BOMB,
    InputFrame, NO_INPUT,
)

# Action index → (dir, action_flag)
_ACTION_MAP = [
    InputFrame(dir=DIR_NONE,  action=0),         # 0: stay
    InputFrame(dir=DIR_UP,    action=0),          # 1: up
    InputFrame(dir=DIR_DOWN,  action=0),          # 2: down
    InputFrame(dir=DIR_LEFT,  action=0),          # 3: left
    InputFrame(dir=DIR_RIGHT, action=0),          # 4: right
    InputFrame(dir=DIR_NONE,  action=ACTION_BOMB), # 5: place bomb
]


class ChoccusEnv(gym.Env):
    metadata = {'render_modes': []}

    def __init__(self, map_kind: str = 'classic', num_opponents: int = 1):
        super().__init__()
        self.map_kind = map_kind
        self.num_players = 1 + num_opponents
        self._state: dict | None = None
        self._prev_items_collected = 0
        self._prev_bricks_destroyed = 0
        self._rng = np.random.default_rng()
        self._annealing_episode = 0
        self._alpha = 0.9995

        self.observation_space = spaces.Dict({
            'grid': spaces.Box(
                low=-1.0, high=1.0,
                shape=(MAP_ROWS, MAP_COLS, 12), dtype=np.float32
            ),
            'scalars': spaces.Box(
                low=-1.0, high=1.0, shape=(9,), dtype=np.float32
            ),
        })
        self.action_space = spaces.Discrete(6)

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        if seed is None:
            seed = int(self._rng.integers(0, 2**31))
        self._state = create_initial_state(seed=seed, map_kind=self.map_kind,
                                            num_players=self.num_players)
        self._prev_items_collected = 0
        self._prev_bricks_destroyed = 0
        self._dense_scale = self._alpha ** self._annealing_episode
        obs = self._obs()
        mask = compute_action_mask(self._state, slot=0)
        return obs, {'action_mask': mask}

    def step(self, action: int):
        assert self._state is not None
        # Build inputs: agent = action; opponents = random safe action
        inputs = [_ACTION_MAP[action]]
        for opp_slot in range(1, self.num_players):
            opp_mask = compute_action_mask(self._state, slot=opp_slot)
            safe = [i for i, ok in enumerate(opp_mask) if ok]
            opp_action = int(self._rng.choice(safe)) if safe else 0
            inputs.append(_ACTION_MAP[opp_action])

        prev_state = self._state
        self._state = tick(self._state, inputs)

        reward = self._reward(prev_state, self._state, action)
        terminated = self._state['phase'] == PHASE_OVER
        truncated = self._state['tick'] >= MATCH_MAX_TICKS
        obs = self._obs()
        mask = compute_action_mask(self._state, slot=0)

        if terminated:
            self._annealing_episode += 1

        return obs, reward, terminated, truncated, {'action_mask': mask}

    def _obs(self):
        grid, scalars = encode_state(self._state, slot=0)
        return {'grid': grid, 'scalars': scalars}

    def _reward(self, prev: dict, curr: dict, action: int) -> float:
        dense = 0.0
        agent = next((p for p in curr['players'] if p['slot'] == 0), None)
        prev_agent = next((p for p in prev['players'] if p['slot'] == 0), None)

        # Alive check
        if agent is None or not agent['alive']:
            if curr['phase'] == PHASE_OVER:
                alive_teams = {p['team'] for p in curr['players'] if p['alive']}
                if 0 not in alive_teams:  # agent's team (team=0) lost
                    return -100.0 + self._dense_scale * dense
            return -100.0

        # Win
        alive_teams = {p['team'] for p in curr['players'] if p['alive']}
        if curr['phase'] == PHASE_OVER and len(alive_teams) <= 1 and 0 in alive_teams:
            return 100.0 + self._dense_scale * dense

        # Enemy eliminated this tick
        prev_alive_enemies = sum(1 for p in prev['players'] if p['alive'] and p['slot'] != 0)
        curr_alive_enemies = sum(1 for p in curr['players'] if p['alive'] and p['slot'] != 0)
        if curr_alive_enemies < prev_alive_enemies:
            dense += 30.0 * (prev_alive_enemies - curr_alive_enemies)

        # Items collected (fire/speed/cannon increase)
        if prev_agent and agent:
            item_gain = (agent['fire'] - prev_agent['fire']) + \
                        (agent['cannon'] - prev_agent['cannon']) + \
                        max(0, agent['speed_bonus_tenths'] - prev_agent['speed_bonus_tenths']) // 10
            dense += 4.0 * item_gain

        # Movement penalty
        if action == 0:
            dense -= 0.05  # stayed still
        else:
            # Moved: small reward for being active, or penalty for hitting wall
            moved = (agent['pos_x'] != prev_agent['pos_x'] or agent['pos_y'] != prev_agent['pos_y']) \
                    if prev_agent else False
            if not moved:
                dense -= 0.2  # bumped into wall

        return self._dense_scale * dense
```

- [ ] **Step 5: 確認測試通過**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_gymnasium_env.py -v
```

Expected: `6 passed`

- [ ] **Step 6: SPS 驗証（目標 ≥ 10,000）**

```bash
python3 - <<'EOF'
import time
from rl.env.choccus_env import ChoccusEnv
env = ChoccusEnv(map_kind='classic', num_opponents=1)
env.reset(seed=0)
N = 5000
start = time.perf_counter()
for _ in range(N):
    obs, r, term, trunc, info = env.step(0)
    if term or trunc:
        env.reset()
elapsed = time.perf_counter() - start
print(f"SPS: {N/elapsed:.0f}")
EOF
```

Expected: `SPS: 10000` 或更高。若未達標，對 `tick()` 做 profiling：`python3 -m cProfile -s cumtime -c "..."`，找出最慢函式（通常是 `copy.deepcopy`）。

若 deepcopy 是瓶頸，改用淺拷貝 + 手動複製可變欄位（players list、grid ndarray），可提升 5–10×。

- [ ] **Step 7: Commit**

```bash
git add rl/env/choccus_env.py rl/tests/test_gymnasium_env.py && git commit -m "feat(rl): Gymnasium wrapper + SPS verified ≥10k (Task 11)"
```

---

## Task 12：安裝驗証 + Phase 1 整合測試

**Files:**
- Create: `rl/tests/test_integration.py`

- [ ] **Step 1: 寫整合測試**

```python
# rl/tests/test_integration.py
"""
End-to-end: environment runs 100 episodes without crash;
reward is finite; observations stay in bounds.
"""
import numpy as np
import pytest
from rl.env.choccus_env import ChoccusEnv


def test_100_episodes_stable():
    env = ChoccusEnv(map_kind='classic', num_opponents=1)
    for ep in range(100):
        obs, _ = env.reset(seed=ep)
        done = False
        steps = 0
        while not done and steps < 12000:
            action = env.action_space.sample()
            obs, reward, term, trunc, info = env.step(action)
            assert np.isfinite(reward), f"episode {ep} step {steps}: non-finite reward {reward}"
            assert obs['grid'].min() >= -1.0 and obs['grid'].max() <= 1.0
            assert obs['scalars'].min() >= -1.0 and obs['scalars'].max() <= 1.0
            done = term or trunc
            steps += 1
        assert done, f"Episode {ep} did not terminate in {steps} steps"


def test_pirate_map_runs():
    env = ChoccusEnv(map_kind='pirate', num_opponents=1)
    obs, _ = env.reset(seed=0)
    for _ in range(100):
        obs, reward, term, trunc, _ = env.step(0)
        if term or trunc:
            break
```

- [ ] **Step 2: 執行整合測試**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/test_integration.py -v
```

Expected: `2 passed`（可能需 30–60 秒）

- [ ] **Step 3: 執行全部測試**

```bash
cd /home/m2553/repo/10-choccus && python3 -m pytest rl/tests/ -v --tb=short
```

Expected: 全部通過，0 errors。

- [ ] **Step 4: 最終 commit**

```bash
git add rl/tests/test_integration.py && git commit -m "feat(rl): Phase 0+1 complete — integration tests pass (Task 12)"
```

---

## Phase 0 通過確認清單

Phase 1 完成後，在進入 Phase 2（訓練計畫）前，確認以下三項全數達標：

| 項目 | 指令 | 門檻 |
|---|---|---|
| 決定性測試 | `pytest rl/tests/test_phase0_determinism.py -v` | 5/5 passed |
| 效能 | SPS benchmark（Task 11 Step 6） | ≥ 10,000 SPS |
| 轉移品質 | （另行執行）BC clone 在真實遊戲 bench 對 v5:zoner 的勝率 | v6:hunter 基準 ±8% |

轉移品質測試在 Phase 2 計畫開頭執行（需先訓練 BC clone），此處先確認前兩項。**三項全過才開始 Phase 2 計畫。**
