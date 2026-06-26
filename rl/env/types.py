# rl/env/types.py
from typing import NamedTuple

# TileKind
TILE_EMPTY = 0
TILE_HARD  = 1
TILE_SOFT  = 2
TILE_PUSH  = 3

def is_destructible_brick(kind: int) -> bool:
    return kind == TILE_SOFT or kind == TILE_PUSH

# Direction bitflags (same as Direction in types.ts)
DIR_NONE  = 0
DIR_UP    = 1 << 0  # 1
DIR_DOWN  = 1 << 1  # 2
DIR_LEFT  = 1 << 2  # 4
DIR_RIGHT = 1 << 3  # 8

# ActionFlags
ACTION_NONE = 0
ACTION_BOMB = 1 << 0  # 1

# GamePhase
PHASE_LOBBY   = 0
PHASE_PLAYING = 1
PHASE_OVER    = 2

# ItemKind
ITEM_FIRE   = 0
ITEM_SPEED  = 1
ITEM_CANNON = 2


class InputFrame(NamedTuple):
    dir: int     # Direction bitflag
    action: int  # ActionFlags bitflag


NO_INPUT = InputFrame(dir=DIR_NONE, action=ACTION_NONE)
