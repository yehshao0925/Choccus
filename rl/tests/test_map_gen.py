"""Tests for map generation."""
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
    # Template row 1 = '.#S#S#S#S#S#S#.' → col 1 = '#' → HARD
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
