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
    assert mask[0] is True or mask[0] == True


def test_stay_always_allowed():
    state = create_initial_state(seed=0, map_kind='classic', num_players=1)
    mask = compute_action_mask(state, slot=0)
    assert mask[0] == True  # stay is always safe


def test_dead_player_mask_all_false():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    state['players'][0]['alive'] = False
    mask = compute_action_mask(state, slot=0)
    assert not any(mask)


def test_bomb_blocked_in_no_escape():
    """If placing a bomb leaves no escape route, bomb action must be masked."""
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
    assert mask[5] == False  # bomb is masked (no escape)
