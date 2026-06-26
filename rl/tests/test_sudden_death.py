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
