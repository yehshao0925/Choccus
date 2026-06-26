# rl/tests/test_sim.py
import pytest
from rl.env.sim import create_initial_state, tick
from rl.env.constants import MILLITILE, FUSE_TICKS, MAP_COLS
from rl.env.types import PHASE_PLAYING, PHASE_OVER, NO_INPUT, InputFrame, ACTION_BOMB, DIR_NONE


def test_initial_state_phase():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    assert state['phase'] == PHASE_PLAYING
    assert state['tick'] == 0
    assert len(state['players']) == 2


def test_tick_increments():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    inputs = [NO_INPUT, NO_INPUT]
    state2 = tick(state, inputs)
    assert state2['tick'] == 1


def test_bomb_fuse_decrements():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    bomb_input = InputFrame(dir=DIR_NONE, action=ACTION_BOMB)
    state2 = tick(state, [bomb_input, NO_INPUT])
    assert len(state2['bombs']) == 1
    assert state2['bombs'][0]['fuse_ticks'] == FUSE_TICKS - 1


def test_game_ends_when_one_player_survives():
    # One player dead, one alive → OVER
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    state['players'][1]['alive'] = False
    state2 = tick(state, [NO_INPUT, NO_INPUT])
    assert state2['phase'] == PHASE_OVER


def test_immutability():
    state = create_initial_state(seed=0, map_kind='classic', num_players=2)
    state2 = tick(state, [NO_INPUT, NO_INPUT])
    # Original state unmodified
    assert state['tick'] == 0
    assert state2['tick'] == 1
