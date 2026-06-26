# rl/tests/test_shell.py
from rl.env.shell import trap_player, step_shells
from rl.env.player import create_player, tile_of
from rl.env.constants import MILLITILE, TRAPPED_TICKS, RESCUE_DIST_MT


def _p(slot, tx, ty, team=None):
    p = create_player(slot, tx, ty, team=team if team is not None else slot)
    return p


def test_trap_snaps_to_center():
    p = _p(0, 3, 3)
    p['pos_x'] = 3400  # off-center
    trap_player(p)
    assert p['trapped'] is True
    assert p['pos_x'] == 3000  # snapped to tile center
    assert p['trapped_ticks'] == TRAPPED_TICKS


def test_rescue_by_teammate():
    victim = _p(0, 3, 3, team=0)
    trap_player(victim)
    rescuer = _p(1, 3, 3, team=0)  # same team, same tile
    step_shells([victim, rescuer])
    assert victim['trapped'] is False
    assert victim['alive'] is True


def test_enemy_breaks_shell():
    victim = _p(0, 3, 3, team=0)
    trap_player(victim)
    enemy = _p(1, 3, 3, team=1)  # different team
    step_shells([victim, enemy])
    assert victim['trapped'] is False
    assert victim['alive'] is False


def test_rescue_priority_over_enemy():
    victim = _p(0, 3, 3, team=0)
    trap_player(victim)
    rescuer = _p(1, 3, 3, team=0)
    enemy   = _p(2, 3, 3, team=1)
    step_shells([victim, rescuer, enemy])
    # Rescue wins (priority per Shell.ts)
    assert victim['alive'] is True
    assert victim['trapped'] is False


def test_timeout_eliminates():
    victim = _p(0, 3, 3)
    trap_player(victim)
    victim['trapped_ticks'] = 1
    step_shells([victim])
    assert victim['alive'] is False
