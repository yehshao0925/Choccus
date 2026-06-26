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
