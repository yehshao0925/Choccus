# rl/env/action_mask.py
"""
Safety action mask: BFS to find at least one safe escape tile.
An action is safe if it leaves the player with at least one reachable tile
that has no active or imminent flame (active cells + in-fuse bombs).

Action indices: 0=stay, 1=up, 2=down, 3=left, 4=right, 5=place_bomb
"""
import numpy as np
from collections import deque
from rl.env.constants import (
    MAP_COLS, MAP_ROWS, MILLITILE, FUSE_TICKS, SPARK_TICKS
)
from rl.env.types import (
    TILE_HARD, TILE_SOFT, TILE_PUSH, TILE_EMPTY,
    DIR_NONE, DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT,
    ACTION_BOMB,
)
from rl.env.player import tile_of
from rl.env.bomb import bomb_at, try_place_bomb, create_bomb
from rl.env.explosion import explosion_at

_DIRECTIONS = [DIR_NONE, DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT]
_DIR_DELTAS = {
    DIR_NONE:  (0,  0),
    DIR_UP:    (0, -1),
    DIR_DOWN:  (0,  1),
    DIR_LEFT:  (-1, 0),
    DIR_RIGHT: (1,  0),
}


def _danger_set(explosions: list[dict], bombs: list[dict]) -> set[tuple[int,int]]:
    """Set of (tx,ty) that are currently or imminently dangerous."""
    danger: set[tuple[int,int]] = set()
    for c in explosions:
        danger.add((c['tile_x'], c['tile_y']))
    for b in bombs:
        # Mark bomb center + all arm tiles
        danger.add((b['tile_x'], b['tile_y']))
        for dx, dy in [(0,-1),(0,1),(-1,0),(1,0)]:
            for step in range(1, b['fire'] + 1):
                tx, ty = b['tile_x'] + dx * step, b['tile_y'] + dy * step
                if tx < 0 or tx >= MAP_COLS or ty < 0 or ty >= MAP_ROWS:
                    break
                danger.add((tx, ty))
    return danger


def _has_escape(
    start_tx: int, start_ty: int,
    grid: np.ndarray,
    bombs: list[dict],
    danger: set[tuple[int,int]],
    max_depth: int = 10,
) -> bool:
    """BFS from (start_tx, start_ty); returns True if any reachable tile is safe."""
    if (start_tx, start_ty) not in danger:
        return True  # current position already safe
    visited = {(start_tx, start_ty)}
    queue = deque([(start_tx, start_ty, 0)])
    while queue:
        cx, cy, depth = queue.popleft()
        if depth >= max_depth:
            continue
        for dx, dy in [(0,-1),(0,1),(-1,0),(1,0)]:
            nx, ny = cx + dx, cy + dy
            if (nx, ny) in visited:
                continue
            if nx < 0 or nx >= MAP_COLS or ny < 0 or ny >= MAP_ROWS:
                continue
            tile = grid[ny * MAP_COLS + nx]
            if tile == TILE_HARD or tile == TILE_SOFT or tile == TILE_PUSH:
                continue
            if bomb_at(bombs, nx, ny) is not None:
                continue
            visited.add((nx, ny))
            if (nx, ny) not in danger:
                return True
            queue.append((nx, ny, depth + 1))
    return False


def compute_action_mask(state: dict, slot: int) -> np.ndarray:
    """Returns bool[6] mask — True = action is safe for agent `slot`."""
    mask = np.zeros(6, dtype=bool)
    players = state['players']
    self_player = next((p for p in players if p['slot'] == slot), None)
    if self_player is None or not self_player['alive']:
        return mask

    grid = state['grid']
    bombs = state['bombs']
    explosions = state['explosions']
    danger = _danger_set(explosions, bombs)

    tx = tile_of(self_player['pos_x'])
    ty = tile_of(self_player['pos_y'])

    # Actions 0-4: movement directions
    for ai, direction in enumerate(_DIRECTIONS):
        dx, dy = _DIR_DELTAS[direction]
        ntx, nty = tx + dx, ty + dy
        # Clamp to grid
        ntx = max(0, min(MAP_COLS - 1, ntx))
        nty = max(0, min(MAP_ROWS - 1, nty))
        # Can we move there?
        if direction != DIR_NONE:
            tile = grid[nty * MAP_COLS + ntx]
            if tile in (TILE_HARD, TILE_SOFT, TILE_PUSH):
                ntx, nty = tx, ty  # blocked: stay at current tile
            elif bomb_at(bombs, ntx, nty) is not None:
                ntx, nty = tx, ty
        if _has_escape(ntx, nty, grid, bombs, danger):
            mask[ai] = True

    # Action 5: place bomb — safe only if escape route exists after placement
    if not self_player['trapped'] and self_player['active_bombs'] < self_player['cannon']:
        if bomb_at(bombs, tx, ty) is None:
            # Simulate placing bomb
            dummy_bomb = create_bomb(slot, tx, ty, self_player['fire'])
            hypothetical_bombs = list(bombs) + [dummy_bomb]
            hyp_danger = _danger_set(explosions, hypothetical_bombs)
            if _has_escape(tx, ty, grid, hypothetical_bombs, hyp_danger):
                mask[5] = True

    return mask
