# rl/env/explosion.py
"""
Explosion (melt-flow) processing + lenient hitbox.
Ported from client/src/sim/Explosion.ts.
"""
import numpy as np
from rl.env.constants import (
    MILLITILE, SPARK_TICKS, ITEM_DROP_RATE, MAP_COLS, MAP_ROWS,
    HIT_COVER_NUM, HIT_COVER_DEN,
)
from rl.env.types import (
    TILE_HARD, TILE_SOFT, TILE_PUSH, TILE_EMPTY,
    is_destructible_brick,
    ITEM_FIRE, ITEM_SPEED, ITEM_CANNON,
)
from rl.env.prng import prng_float, prng_int
from rl.env.player import tile_of  # canonical tile_of — do NOT redefine here

# Fixed arm processing order: UP, DOWN, LEFT, RIGHT
_ARM_DELTAS = [(0, -1), (0, 1), (-1, 0), (1, 0)]


def _in_bounds(x: int, y: int) -> bool:
    return 0 <= x < MAP_COLS and 0 <= y < MAP_ROWS


def _idx(x: int, y: int) -> int:
    return y * MAP_COLS + x


def explosion_at(cells: list[dict], tx: int, ty: int) -> bool:
    for c in cells:
        if c['tile_x'] == tx and c['tile_y'] == ty:
            return True
    return False


def process_detonations(
    grid: np.ndarray, bombs: list[dict], prng: int
) -> dict:
    """
    Detonate all bombs with fuse_ticks <= 0 (including chains).
    MUTATES grid (caller passes tick-start clone). Returns result dict.
    Mirrors processDetonations in Explosion.ts.
    """
    detonated = [False] * len(bombs)
    queue: list[int] = []
    for i, b in enumerate(bombs):
        if b['fuse_ticks'] <= 0:
            detonated[i] = True
            queue.append(i)

    # Tick-start grid snapshot: blast arms read THIS, not the mutating grid.
    start_grid = grid.copy()

    cells: list[dict] = []
    items: list[dict] = []
    detonated_owners: list[int] = []
    p = prng

    q_idx = 0
    while q_idx < len(queue):
        bi = queue[q_idx]
        q_idx += 1
        bomb = bombs[bi]
        detonated_owners.append(bomb['owner_slot'])
        cells.append({'tile_x': bomb['tile_x'], 'tile_y': bomb['tile_y'], 'ttl_ticks': SPARK_TICKS})

        for (dx, dy) in _ARM_DELTAS:
            for step in range(1, bomb['fire'] + 1):
                tx = bomb['tile_x'] + dx * step
                ty = bomb['tile_y'] + dy * step
                if not _in_bounds(tx, ty):
                    break
                cell = _idx(tx, ty)
                if start_grid[cell] == TILE_HARD:
                    break
                if is_destructible_brick(start_grid[cell]):
                    # Destroy only once (if still destructible in live grid)
                    if is_destructible_brick(grid[cell]):
                        grid[cell] = TILE_EMPTY
                        roll, p = prng_float(p)
                        if roll < ITEM_DROP_RATE:
                            kind_v, p = prng_int(p, 0, 2)
                            items.append({'tile_x': tx, 'tile_y': ty, 'kind': kind_v})
                    break  # arm stops at destructible brick, NO cell here
                # Empty tile: chain any undetonated bomb here, then continue arm
                for j, other in enumerate(bombs):
                    if not detonated[j] and other['tile_x'] == tx and other['tile_y'] == ty:
                        detonated[j] = True
                        queue.append(j)
                        break
                cells.append({'tile_x': tx, 'tile_y': ty, 'ttl_ticks': SPARK_TICKS})

    surviving_bombs = [b for i, b in enumerate(bombs) if not detonated[i]]
    return {
        'bombs': surviving_bombs,
        'cells': cells,
        'items': items,
        'detonated_owners': detonated_owners,
        'prng': p,
    }


def explosion_covers(cells: list[dict], pos_x: int, pos_y: int) -> bool:
    """
    True when player body (1-tile box centred on pos_x,pos_y) is >= 2/3 covered.
    Mirrors explosionCovers in Explosion.ts — integer arithmetic only.
    tile_of imported from player.py (canonical definition, not redefined here).
    """
    tx = tile_of(pos_x)
    ty = tile_of(pos_y)
    ox = pos_x - tx * MILLITILE
    oy = pos_y - ty * MILLITILE
    sx = 1 if ox >= 0 else -1
    sy = 1 if oy >= 0 else -1
    area = 0
    for nx in [0, sx]:
        ovx = MILLITILE - abs(ox - nx * MILLITILE)
        if ovx <= 0:
            continue
        for ny in [0, sy]:
            ovy = MILLITILE - abs(oy - ny * MILLITILE)
            if ovy > 0 and explosion_at(cells, tx + nx, ty + ny):
                area += ovx * ovy
    return area * HIT_COVER_DEN >= HIT_COVER_NUM * MILLITILE * MILLITILE
