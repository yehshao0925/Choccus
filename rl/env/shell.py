# rl/env/shell.py
"""Sugar shell (trap/rescue) logic. Ported from client/src/sim/Shell.ts."""
from rl.env.constants import MILLITILE, TRAPPED_TICKS, RESCUE_DIST_MT
from rl.env.player import tile_of


def _within_dist(ax, ay, bx, by, dist_mt: int) -> bool:
    dx = ax - bx
    dy = ay - by
    return dx * dx + dy * dy <= dist_mt * dist_mt


def trap_player(player: dict) -> None:
    """Seal player in a sugar shell; snaps to tile center. MUTATES."""
    if not player['alive'] or player['trapped']:
        return
    player['trapped'] = True
    player['trapped_ticks'] = TRAPPED_TICKS
    player['pos_x'] = tile_of(player['pos_x']) * MILLITILE
    player['pos_y'] = tile_of(player['pos_y']) * MILLITILE


def _break_shell(player: dict) -> None:
    player['trapped'] = False
    player['trapped_ticks'] = 0
    player['alive'] = False


def step_shells(players: list[dict]) -> None:
    """Per-tick shell pass. MUTATES player dicts. Mirrors stepShells in Shell.ts."""
    for p in players:
        if not p['alive'] or not p['trapped']:
            continue
        # Phase A1: same-team rescue (priority)
        rescued = False
        for q in players:
            if q is p or not q['alive'] or q['trapped']:
                continue
            if q['team'] != p['team']:
                continue
            if _within_dist(p['pos_x'], p['pos_y'], q['pos_x'], q['pos_y'], RESCUE_DIST_MT):
                p['trapped'] = False
                p['trapped_ticks'] = 0
                rescued = True
                break
        if rescued:
            continue
        # Phase A2: enemy contact → instant break
        for q in players:
            if q is p or not q['alive'] or q['trapped']:
                continue
            if q['team'] == p['team']:
                continue
            if _within_dist(p['pos_x'], p['pos_y'], q['pos_x'], q['pos_y'], RESCUE_DIST_MT):
                _break_shell(p)
                break
    # Phase B: age timers
    for p in players:
        if not p['alive'] or not p['trapped']:
            continue
        p['trapped_ticks'] -= 1
        if p['trapped_ticks'] <= 0:
            _break_shell(p)
