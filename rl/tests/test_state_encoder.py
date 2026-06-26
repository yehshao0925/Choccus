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
