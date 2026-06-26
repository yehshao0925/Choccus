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
    to    = hardened_count(tick)
    from_ = hardened_count(tick - 1)
    for i in range(from_, to):
        x, y = SPIRAL_ORDER[i]
        grid[y * MAP_COLS + x] = TILE_HARD
        for p in players:
            if p['alive'] and tile_of(p['pos_x']) == x and tile_of(p['pos_y']) == y:
                p['alive'] = False
                p['trapped'] = False
                p['trapped_ticks'] = 0
