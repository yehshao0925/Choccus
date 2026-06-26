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
