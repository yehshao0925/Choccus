# rl/env/state_encoder.py
"""
SimState dict → numpy arrays for Gymnasium observations.
Output: (grid: float32[13,15,12], scalars: float32[9])

Channels (15×13 each):
  0: hard walls (0/1)
  1: soft bricks (0/1)
  2: pushable crates (0/1)
  3: self position (0/1, tile-center rounded)
  4: enemy positions (0/1)
  5: bomb fuse timers (t_remaining/180)
  6: current flame cells (0/1)
  7: predicted explosion zones (0/1, based on in-flight bombs)
  8: items on ground (1=fire/3, 2=speed/3, 3=cannon/3)
  9: sudden-death hardened tiles (0/1)
 10: trapped players (0/1)
 11: time progress (tick/10800, same value all cells)

Scalars (9):
  0: self fire / 7
  1: self cannon / 6
  2: self speed_bonus_tenths / 30
  3: self active_bombs / 6
  4: alive enemy count / 3
  5: in sudden death period (0/1)
  6: push charge progress / 30
  7: self_ox = (pos_x - tile_center_x) / 500  ∈ [-1,1)
  8: self_oy = (pos_y - tile_center_y) / 500  ∈ [-1,1)
"""
import numpy as np
from rl.env.constants import (
    MAP_ROWS, MAP_COLS, MILLITILE, FUSE_TICKS,
    MATCH_MAX_TICKS, SUDDEN_DEATH_START_TICK,
    PLAYER_MAX_FIRE, PLAYER_MAX_CANNON, PUSH_CHARGE_TICKS,
)
from rl.env.types import TILE_HARD, TILE_SOFT, TILE_PUSH, ITEM_FIRE, ITEM_SPEED, ITEM_CANNON
from rl.env.player import tile_of
from rl.env.sudden_death import SPIRAL_ORDER, hardened_count


def _predicted_explosion_zones(bombs: list[dict], grid_raw: np.ndarray) -> np.ndarray:
    """Mark all tiles a placed bomb could reach given its fire power."""
    ch = np.zeros((MAP_ROWS, MAP_COLS), dtype=np.float32)
    for b in bombs:
        bx, by = b['tile_x'], b['tile_y']
        ch[by, bx] = 1.0
        for dx, dy in [(0, -1), (0, 1), (-1, 0), (1, 0)]:
            for step in range(1, b['fire'] + 1):
                tx, ty = bx + dx * step, by + dy * step
                if tx < 0 or tx >= MAP_COLS or ty < 0 or ty >= MAP_ROWS:
                    break
                tile = grid_raw[ty * MAP_COLS + tx]
                if tile == TILE_HARD:
                    break
                ch[ty, tx] = 1.0
                if tile == TILE_SOFT or tile == TILE_PUSH:
                    break  # flame stops at destructible brick
    return ch


def encode_state(state: dict, slot: int) -> tuple[np.ndarray, np.ndarray]:
    """Encode SimState for agent `slot`. Returns (grid [13,15,12], scalars [9])."""
    grid_raw = state['grid']
    players = state['players']
    bombs = state['bombs']
    explosions = state['explosions']
    items = state['items']
    t = state['tick']

    ch = np.zeros((MAP_ROWS, MAP_COLS, 12), dtype=np.float32)

    # Ch 0-2: tile types (vectorized — replaces nested Python loop)
    grid_2d = grid_raw.reshape(MAP_ROWS, MAP_COLS)
    ch[:, :, 0] = (grid_2d == TILE_HARD).astype(np.float32)
    ch[:, :, 1] = (grid_2d == TILE_SOFT).astype(np.float32)
    ch[:, :, 2] = (grid_2d == TILE_PUSH).astype(np.float32)

    # Ch 3: self position; Ch 4: enemy positions; Ch 10: trapped players
    self_player = None
    for p in players:
        if not p['alive']:
            continue
        tx = tile_of(p['pos_x'])
        ty = tile_of(p['pos_y'])
        if p['slot'] == slot:
            self_player = p
            ch[ty, tx, 3] = 1.0
        else:
            ch[ty, tx, 4] = 1.0
        if p['trapped']:
            ch[ty, tx, 10] = 1.0

    # Ch 5: bomb fuse timers (normalized: remaining/max)
    for b in bombs:
        ch[b['tile_y'], b['tile_x'], 5] = b['fuse_ticks'] / FUSE_TICKS

    # Ch 6: active flame cells
    for c in explosions:
        if 0 <= c['tile_y'] < MAP_ROWS and 0 <= c['tile_x'] < MAP_COLS:
            ch[c['tile_y'], c['tile_x'], 6] = 1.0

    # Ch 7: predicted explosion zones
    ch[:, :, 7] = _predicted_explosion_zones(bombs, grid_raw)

    # Ch 8: items on ground (encoded as fraction of 3 item kinds)
    item_value = {ITEM_FIRE: 1 / 3, ITEM_SPEED: 2 / 3, ITEM_CANNON: 1.0}
    for it in items:
        ch[it['tile_y'], it['tile_x'], 8] = item_value.get(it['kind'], 0.0)

    # Ch 9: sudden death hardened tiles
    count = hardened_count(t)
    for i in range(count):
        x, y = SPIRAL_ORDER[i]
        ch[y, x, 9] = 1.0

    # Ch 11: time progress (constant plane)
    ch[:, :, 11] = t / MATCH_MAX_TICKS

    # ── Scalars ──────────────────────────────────────────────────────────────
    in_sd = 1.0 if t >= SUDDEN_DEATH_START_TICK else 0.0
    alive_enemies = sum(1 for p in players if p['alive'] and p['slot'] != slot)

    if self_player is not None:
        pos_x = self_player['pos_x']
        pos_y = self_player['pos_y']
        # Sub-tile offset from the nearest tile center: 0 at tile center
        ox = pos_x - tile_of(pos_x) * MILLITILE
        oy = pos_y - tile_of(pos_y) * MILLITILE
        half = MILLITILE // 2  # 500

        scalars = np.array([
            self_player['fire'] / PLAYER_MAX_FIRE,           # 0
            self_player['cannon'] / PLAYER_MAX_CANNON,        # 1
            self_player['speed_bonus_tenths'] / 30.0,         # 2
            self_player['active_bombs'] / PLAYER_MAX_CANNON,  # 3
            alive_enemies / 3.0,                              # 4
            in_sd,                                            # 5
            self_player['push_charge_ticks'] / PUSH_CHARGE_TICKS,  # 6
            ox / half,                                        # 7: self_ox ∈ [-1, 1)
            oy / half,                                        # 8: self_oy ∈ [-1, 1)
        ], dtype=np.float32)
    else:
        scalars = np.zeros(9, dtype=np.float32)

    return ch, scalars
