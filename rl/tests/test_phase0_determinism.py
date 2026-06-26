# rl/tests/test_phase0_determinism.py
"""
Phase 0 gate: Python sim must reproduce TS sim outcomes for all scripted scenarios.
"""
import json
import pytest
from pathlib import Path
from rl.env.sim import create_initial_state, tick
from rl.env.types import PHASE_PLAYING, InputFrame, DIR_NONE, DIR_RIGHT, DIR_LEFT, ACTION_BOMB

FIXTURES = json.loads(
    (Path(__file__).parent / 'fixtures' / 'phase0_scenarios.json').read_text()
)

def _input_fn(idx: int, t: int, slot: int) -> InputFrame:
    if idx == 0:
        return InputFrame(dir=DIR_NONE, action=0)
    elif idx == 1:
        return InputFrame(dir=DIR_NONE, action=ACTION_BOMB if t == 0 and slot == 0 else 0)
    elif idx == 2:
        return InputFrame(dir=DIR_RIGHT if slot == 0 else DIR_LEFT, action=0)
    elif idx == 3:
        return InputFrame(dir=DIR_NONE, action=ACTION_BOMB if t == 5 else 0)
    else:  # idx == 4
        d = DIR_RIGHT if slot == 0 else DIR_LEFT
        return InputFrame(dir=d if t < 10 else DIR_NONE, action=ACTION_BOMB if t == 30 else 0)


def _run_python_scenario(idx: int, scenario: dict) -> dict:
    """Replay the same scripted inputs in the Python sim."""
    seed = scenario['seed']
    map_kind = scenario['map_kind']
    num_players = scenario['num_players']
    state = create_initial_state(seed=seed, map_kind=map_kind, num_players=num_players)
    while state['phase'] == PHASE_PLAYING and state['tick'] < 10800:
        t = state['tick']
        inputs = [_input_fn(idx, t, i) for i in range(num_players)]
        state = tick(state, inputs)
    alive = [p for p in state['players'] if p['alive']]
    winner_slot = alive[0]['slot'] if len(alive) == 1 else None
    return {'winner_slot': winner_slot, 'duration_ticks': state['tick']}


@pytest.mark.parametrize("idx,scenario", list(enumerate(FIXTURES)))
def test_matches_ts_outcome(idx, scenario):
    result = _run_python_scenario(idx, scenario)
    assert result['winner_slot'] == scenario['winner_slot'], (
        f"Seed {scenario['seed']}: winner mismatch "
        f"Python={result['winner_slot']} TS={scenario['winner_slot']}"
    )
    assert result['duration_ticks'] == scenario['duration_ticks'], (
        f"Seed {scenario['seed']}: duration mismatch "
        f"Python={result['duration_ticks']} TS={scenario['duration_ticks']}"
    )
