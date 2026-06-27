# rl/env/sim.py
"""
SimState + fixed-order tick(). Ported from client/src/sim/Sim.ts.
Tick system order (do NOT reorder — determinism contract):
  1. players: resolve input & move
  2. bomb placement from action edges
  3. fuse decrement; detonations → explosion cells, brick destruction, item drops
  4. explosion-cell hits: trap players
  5. item pickups
  6. shells: rescue then timers → elimination
  7. age & cull explosion cells
  8. sudden death
  9. win check → phase OVER
 10. tick + 1
"""
import numpy as np
from rl.env.constants import (
    MILLITILE, FUSE_TICKS, SPARK_TICKS, MATCH_MAX_TICKS,
    MAP_COLS, MAP_ROWS, PUSH_CHARGE_TICKS,
    DEFAULT_MOVE_SPEED, DEFAULT_CORNER_ASSIST, DEFAULT_INPUT_BUFFER_MS, TICK_HZ,
)
from rl.env.types import (
    PHASE_PLAYING, PHASE_OVER,
    DIR_NONE, DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT,
    ACTION_BOMB,
    InputFrame, NO_INPUT,
    TILE_EMPTY, TILE_HARD, TILE_PUSH,
)
from rl.env.map_gen import generate_map, map_spawns
from rl.env.player import (
    create_player, step_entity, tile_of,
    player_speed_mt_per_tick,
)
from rl.env.bomb import bomb_at, bomb_pressed_edge, try_place_bomb
from rl.env.explosion import process_detonations, explosion_covers
from rl.env.item import apply_item
from rl.env.shell import step_shells, trap_player
from rl.env.sudden_death import step_sudden_death

_MOVE_SPEED_MT = round(DEFAULT_MOVE_SPEED * MILLITILE)       # 5000
_CORNER_ASSIST_MT = round(DEFAULT_CORNER_ASSIST * MILLITILE)  # 250
_INPUT_BUFFER_TICKS = round(DEFAULT_INPUT_BUFFER_MS / (1000 / TICK_HZ))  # 7


def create_initial_state(seed: int, map_kind: str = 'classic', num_players: int = 4) -> dict:
    grid, prng = generate_map(seed, map_kind)
    spawns = map_spawns(map_kind)
    players = []
    for i in range(num_players):
        sx, sy = spawns[i % len(spawns)]
        players.append(create_player(slot=i, tile_x=sx, tile_y=sy, team=i))
    return {
        'tick': 0,
        'phase': PHASE_PLAYING,
        'prng': prng,
        'map_kind': map_kind,
        'grid': grid,
        'players': players,
        'bombs': [],
        'explosions': [],
        'items': [],
    }


def _is_open(grid: np.ndarray, bombs: list[dict], x: int, y: int) -> bool:
    if x < 0 or x >= MAP_COLS or y < 0 or y >= MAP_ROWS:
        return False
    if grid[y * MAP_COLS + x] != TILE_EMPTY:
        return False
    return bomb_at(bombs, x, y) is None


def _dir_dx(d: int) -> int:
    return -1 if d == DIR_LEFT else (1 if d == DIR_RIGHT else 0)


def _dir_dy(d: int) -> int:
    return -1 if d == DIR_UP else (1 if d == DIR_DOWN else 0)


def can_push(
    grid: np.ndarray, bombs: list[dict],
    pos_x: int, pos_y: int, direction: int,
) -> bool:
    """True if a PUSH crate is directly ahead and can be shoved.
    Requires player to be exactly tile-centred on both axes.
    Mirrors canPush in client/src/sim/Player.ts."""
    if pos_x % MILLITILE != 0 or pos_y % MILLITILE != 0:
        return False
    dx = _dir_dx(direction)
    dy = _dir_dy(direction)
    if dx == 0 and dy == 0:
        return False
    cx = tile_of(pos_x)
    cy = tile_of(pos_y)
    ax, ay = cx + dx, cy + dy   # tile directly ahead (the crate)
    bx, by = ax + dx, ay + dy   # tile beyond (where crate slides to)
    if not (0 <= ax < MAP_COLS and 0 <= ay < MAP_ROWS):
        return False
    if grid[ay * MAP_COLS + ax] != TILE_PUSH:
        return False
    return _is_open(grid, bombs, bx, by)


def apply_push(grid: np.ndarray, pos_x: int, pos_y: int, direction: int) -> None:
    """Slide the PUSH crate one tile ahead. MUTATES grid.
    Caller must have verified can_push this tick.
    Mirrors applyPush in client/src/sim/Player.ts."""
    dx = _dir_dx(direction)
    dy = _dir_dy(direction)
    ax = tile_of(pos_x) + dx
    ay = tile_of(pos_y) + dy
    grid[ay * MAP_COLS + ax] = TILE_EMPTY
    grid[(ay + dy) * MAP_COLS + (ax + dx)] = TILE_PUSH


def _copy_state(state: dict) -> dict:
    """Shallow-copy state, manually copying each mutable field.

    Avoids copy.deepcopy overhead (~3× faster) while staying correct:
    - grid: numpy array — use ndarray.copy()
    - players/bombs/explosions/items: list of flat dicts — copy each dict
    - held_stack inside player: a list that is never mutated by the sim,
      but copy it to avoid any shared-reference surprises
    - prng / tick / phase / map_kind: scalars / str — no copy needed
    """
    s: dict = {
        'tick': state['tick'],
        'phase': state['phase'],
        'prng': state['prng'],
        'map_kind': state['map_kind'],
        'grid': state['grid'].copy(),
        'players': [
            {**p, 'held_stack': list(p['held_stack'])}
            for p in state['players']
        ],
        'bombs': [dict(b) for b in state['bombs']],
        'explosions': [dict(e) for e in state['explosions']],
        'items': [dict(i) for i in state['items']],
    }
    return s


def tick(state: dict, inputs: list[InputFrame]) -> dict:
    """Advance state by one tick. Returns a NEW state (does not mutate input)."""
    s = _copy_state(state)
    grid = s['grid']
    players = s['players']
    bombs = s['bombs']
    explosions = s['explosions']
    items = s['items']
    prng = s['prng']

    # ── Step 1: resolve input & move ─────────────────────────────────────────
    for i, p in enumerate(players):
        if not p['alive'] or p['trapped']:
            p['push_charge_dir'] = 0
            p['push_charge_ticks'] = 0
            continue
        inp = inputs[i] if i < len(inputs) else NO_INPUT
        speed = player_speed_mt_per_tick(_MOVE_SPEED_MT, p['speed_bonus_tenths'])

        def open_fn(ax, bx, _g=grid, _b=bombs):
            return _is_open(_g, _b, ax, bx)

        d = inp.dir
        charging = False
        if d != DIR_NONE:
            nx, ny, moved = step_entity(open_fn, p['pos_x'], p['pos_y'], d, speed, _CORNER_ASSIST_MT)
            if moved:
                p['pos_x'] = nx
                p['pos_y'] = ny
                p['facing'] = d
            elif can_push(grid, bombs, p['pos_x'], p['pos_y'], d):
                p['facing'] = d
                charging = True
                p['push_charge_ticks'] = (
                    p['push_charge_ticks'] + 1 if p['push_charge_dir'] == d else 1
                )
                p['push_charge_dir'] = d
                if p['push_charge_ticks'] >= PUSH_CHARGE_TICKS:
                    apply_push(grid, p['pos_x'], p['pos_y'], d)
                    p['push_charge_ticks'] = 0
                    p['push_charge_dir'] = 0
        if not charging:
            p['push_charge_dir'] = 0
            p['push_charge_ticks'] = 0

    # Step 1½: a pushed crate may now sit on a floor item — remove that item.
    # (grid was mutated above; item-tile==PUSH ⟺ a crate just slid onto it.)
    if items:
        items = [it for it in items if grid[it['tile_y'] * MAP_COLS + it['tile_x']] != TILE_PUSH]

    # ── Step 2: bomb placement ────────────────────────────────────────────────
    new_bombs = list(bombs)
    for i, p in enumerate(players):
        inp = inputs[i] if i < len(inputs) else NO_INPUT
        if bomb_pressed_edge(p['prev_action'], inp.action):
            tx = tile_of(p['pos_x'])
            ty = tile_of(p['pos_y'])
            b = try_place_bomb(new_bombs, p, tx, ty)
            if b is not None:
                new_bombs.append(b)
        p['prev_action'] = inp.action

    # ── Step 3: fuse decrement + detonations ─────────────────────────────────
    for b in new_bombs:
        b['fuse_ticks'] -= 1

    result = process_detonations(grid, new_bombs, prng)
    bombs_after = result['bombs']
    new_cells = result['cells']
    new_items = result['items']
    prng = result['prng']
    # Credit detonated owners
    detonated_owners = result['detonated_owners']
    owner_counts: dict[int, int] = {}
    for owner in detonated_owners:
        owner_counts[owner] = owner_counts.get(owner, 0) + 1
    for p in players:
        if p['slot'] in owner_counts:
            p['active_bombs'] = max(0, p['active_bombs'] - owner_counts[p['slot']])

    all_cells = [c for c in explosions if c['ttl_ticks'] > 0] + new_cells

    # ── Step 4: explosion hits → trap players ────────────────────────────────
    for p in players:
        if not p['alive'] or p['trapped']:
            continue
        if explosion_covers(all_cells, p['pos_x'], p['pos_y']):
            trap_player(p)

    # ── Step 5: item pickups ──────────────────────────────────────────────────
    items_remaining = list(items) + new_items
    items_after = []
    for it in items_remaining:
        claimed = False
        for p in players:
            if p['alive'] and not p['trapped']:
                if tile_of(p['pos_x']) == it['tile_x'] and tile_of(p['pos_y']) == it['tile_y']:
                    apply_item(p, it['kind'])
                    claimed = True
                    break
        if not claimed:
            items_after.append(it)

    # ── Step 6: shells ────────────────────────────────────────────────────────
    step_shells(players)

    # ── Step 7: age & cull explosion cells ───────────────────────────────────
    explosions_after = []
    for c in all_cells:
        c['ttl_ticks'] -= 1
        if c['ttl_ticks'] > 0:
            explosions_after.append(c)

    # ── Step 8: sudden death ──────────────────────────────────────────────────
    step_sudden_death(grid, players, s['tick'] + 1)  # applies at new tick

    # ── Step 9: win check ─────────────────────────────────────────────────────
    alive_teams = {p['team'] for p in players if p['alive']}
    if len(alive_teams) <= 1 or s['tick'] + 1 >= MATCH_MAX_TICKS:
        phase = PHASE_OVER
    else:
        phase = PHASE_PLAYING

    return {
        'tick': s['tick'] + 1,
        'phase': phase,
        'prng': prng,
        'map_kind': s['map_kind'],
        'grid': grid,
        'players': players,
        'bombs': bombs_after,
        'explosions': explosions_after,
        'items': items_after,
    }
