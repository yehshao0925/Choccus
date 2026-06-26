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
