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
