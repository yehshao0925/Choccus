# rl/tests/test_push_mechanic.py
"""
Tests for PUSH crate mechanic ported from client/src/sim/Player.ts.
Covers: can_push predicate, apply_push grid mutation, charge accumulation,
item deletion when a crate is pushed onto a floor item.
"""
import numpy as np
import pytest
from rl.env.sim import can_push, apply_push, create_initial_state, tick
from rl.env.constants import MAP_COLS, MAP_ROWS, MILLITILE, PUSH_CHARGE_TICKS
from rl.env.types import (
    TILE_EMPTY, TILE_HARD, TILE_SOFT, TILE_PUSH,
    DIR_RIGHT, DIR_LEFT, DIR_DOWN, DIR_UP, DIR_NONE,
    InputFrame,
)


def _make_grid(*tiles: tuple[int, int, int]) -> np.ndarray:
    """Return an all-EMPTY grid with specific (x, y, kind) tiles set."""
    g = np.zeros(MAP_ROWS * MAP_COLS, dtype=np.uint8)
    for x, y, kind in tiles:
        g[y * MAP_COLS + x] = kind
    return g


# ─── can_push ────────────────────────────────────────────────────────────────

def test_can_push_returns_true_when_clear():
    # Player at (2,2), PUSH at (3,2), EMPTY at (4,2)
    g = _make_grid((3, 2, TILE_PUSH))
    assert can_push(g, [], 2 * MILLITILE, 2 * MILLITILE, DIR_RIGHT) is True


def test_can_push_false_when_not_centred():
    g = _make_grid((3, 2, TILE_PUSH))
    # pos_x is off-centre by 1 millitile
    assert can_push(g, [], 2 * MILLITILE + 1, 2 * MILLITILE, DIR_RIGHT) is False


def test_can_push_false_when_tile_ahead_not_push():
    g = _make_grid((3, 2, TILE_SOFT))
    assert can_push(g, [], 2 * MILLITILE, 2 * MILLITILE, DIR_RIGHT) is False


def test_can_push_false_when_destination_blocked():
    # PUSH at (3,2), HARD at (4,2) — crate cannot slide
    g = _make_grid((3, 2, TILE_PUSH), (4, 2, TILE_HARD))
    assert can_push(g, [], 2 * MILLITILE, 2 * MILLITILE, DIR_RIGHT) is False


def test_can_push_false_when_destination_has_bomb():
    from rl.env.bomb import create_bomb
    g = _make_grid((3, 2, TILE_PUSH))
    bombs = [create_bomb(owner_slot=0, tile_x=4, tile_y=2, fire=2)]
    assert can_push(g, bombs, 2 * MILLITILE, 2 * MILLITILE, DIR_RIGHT) is False


# ─── apply_push ──────────────────────────────────────────────────────────────

def test_apply_push_moves_crate_right():
    g = _make_grid((3, 2, TILE_PUSH))
    apply_push(g, 2 * MILLITILE, 2 * MILLITILE, DIR_RIGHT)
    assert g[2 * MAP_COLS + 3] == TILE_EMPTY   # vacated
    assert g[2 * MAP_COLS + 4] == TILE_PUSH    # landed


def test_apply_push_moves_crate_up():
    g = _make_grid((3, 2, TILE_PUSH))
    # Player at (3,3) pushing UP, crate at (3,2) → crate goes to (3,1)
    apply_push(g, 3 * MILLITILE, 3 * MILLITILE, DIR_UP)
    assert g[2 * MAP_COLS + 3] == TILE_EMPTY
    assert g[1 * MAP_COLS + 3] == TILE_PUSH


# ─── charge accumulation via tick() ──────────────────────────────────────────

def _push_state(px: int = 2, py: int = 6, cx: int = 3, cy: int = 6):
    """
    Build a state with a clear push path:
      player0 at (px, py) tile-centred,
      PUSH at (cx, cy),
      EMPTY at (cx+1, cy).
    Player1 is parked at (1,1) with DIR_NONE inputs.
    """
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    g = state['grid']
    g[py * MAP_COLS + px] = TILE_EMPTY   # player0 tile
    g[cy * MAP_COLS + cx] = TILE_PUSH    # crate
    g[cy * MAP_COLS + (cx + 1)] = TILE_EMPTY  # destination
    state['players'][0]['pos_x'] = px * MILLITILE
    state['players'][0]['pos_y'] = py * MILLITILE
    state['players'][1]['pos_x'] = 1 * MILLITILE
    state['players'][1]['pos_y'] = 1 * MILLITILE
    return state, cx, cy


def test_push_charge_accumulates_and_fires():
    """Player holds DIR_RIGHT for PUSH_CHARGE_TICKS ticks → crate slides right."""
    state, cx, cy = _push_state()
    inp = [InputFrame(dir=DIR_RIGHT, action=0), InputFrame(dir=DIR_NONE, action=0)]

    # PUSH_CHARGE_TICKS - 1 ticks: crate must NOT have moved yet.
    for t in range(PUSH_CHARGE_TICKS - 1):
        state = tick(state, inp)
        assert state['grid'][cy * MAP_COLS + cx] == TILE_PUSH, f"crate moved too early at tick {t+1}"
    assert state['players'][0]['push_charge_ticks'] == PUSH_CHARGE_TICKS - 1

    # Final tick: charge fires, crate slides.
    state = tick(state, inp)
    assert state['grid'][cy * MAP_COLS + cx] == TILE_EMPTY, "crate should vacate (cx,cy)"
    assert state['grid'][cy * MAP_COLS + (cx + 1)] == TILE_PUSH, "crate should be at (cx+1,cy)"
    assert state['players'][0]['push_charge_ticks'] == 0, "charge resets after push"


def test_push_charge_resets_on_direction_change():
    """Charge resets when the player switches direction mid-push."""
    state, cx, cy = _push_state()
    inp_right = [InputFrame(dir=DIR_RIGHT, action=0), InputFrame(dir=DIR_NONE, action=0)]
    inp_left  = [InputFrame(dir=DIR_LEFT,  action=0), InputFrame(dir=DIR_NONE, action=0)]

    half = PUSH_CHARGE_TICKS // 2
    for _ in range(half):
        state = tick(state, inp_right)
    assert state['players'][0]['push_charge_ticks'] == half

    # Switch direction → charge must reset.
    state = tick(state, inp_left)
    assert state['players'][0]['push_charge_ticks'] == 0, "charge must reset on direction change"
    assert state['grid'][cy * MAP_COLS + cx] == TILE_PUSH, "crate must not have moved"


# ─── item deletion when crate pushed onto it ─────────────────────────────────

def test_item_deleted_when_crate_pushed_onto_it():
    """After a push, any floor item on the crate's new tile is removed."""
    from rl.env.types import ITEM_FIRE
    state, cx, cy = _push_state()
    # Place a floor item exactly at the crate destination (cx+1, cy).
    state['items'] = [{'tile_x': cx + 1, 'tile_y': cy, 'kind': ITEM_FIRE}]

    inp = [InputFrame(dir=DIR_RIGHT, action=0), InputFrame(dir=DIR_NONE, action=0)]
    for _ in range(PUSH_CHARGE_TICKS):
        state = tick(state, inp)

    # Crate slid onto (cx+1, cy), item must be gone.
    assert state['grid'][cy * MAP_COLS + (cx + 1)] == TILE_PUSH, "crate should be at destination"
    assert state['items'] == [], "item under crate must be deleted"
