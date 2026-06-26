# rl/env/choccus_env.py
"""
Gymnasium environment wrapping the Python Choccus sim.
Agent controls slot 0; opponents run a rule-based policy (random safe action).
"""
import numpy as np
import gymnasium as gym
from gymnasium import spaces
from rl.env.sim import create_initial_state, tick
from rl.env.state_encoder import encode_state
from rl.env.action_mask import compute_action_mask
from rl.env.constants import (
    MAP_ROWS, MAP_COLS, MATCH_MAX_TICKS,
)
from rl.env.types import (
    PHASE_OVER,
    DIR_NONE, DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT, ACTION_BOMB,
    InputFrame,
)

# Action index → (dir, action_flag)
_ACTION_MAP = [
    InputFrame(dir=DIR_NONE,  action=0),          # 0: stay
    InputFrame(dir=DIR_UP,    action=0),           # 1: up
    InputFrame(dir=DIR_DOWN,  action=0),           # 2: down
    InputFrame(dir=DIR_LEFT,  action=0),           # 3: left
    InputFrame(dir=DIR_RIGHT, action=0),           # 4: right
    InputFrame(dir=DIR_NONE,  action=ACTION_BOMB), # 5: place bomb
]


class ChoccusEnv(gym.Env):
    metadata = {'render_modes': []}

    def __init__(self, map_kind: str = 'classic', num_opponents: int = 1):
        super().__init__()
        self.map_kind = map_kind
        self.num_players = 1 + num_opponents
        self._state: dict | None = None
        self._rng = np.random.default_rng()
        self._annealing_episode = 0
        self._alpha = 0.9995
        self._dense_scale = 1.0

        self.observation_space = spaces.Dict({
            'grid': spaces.Box(
                low=-1.0, high=1.0,
                shape=(MAP_ROWS, MAP_COLS, 12), dtype=np.float32
            ),
            'scalars': spaces.Box(
                low=-1.0, high=1.0, shape=(9,), dtype=np.float32
            ),
        })
        self.action_space = spaces.Discrete(6)

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        if seed is None:
            seed = int(self._rng.integers(0, 2**31))
        self._state = create_initial_state(seed=seed, map_kind=self.map_kind,
                                            num_players=self.num_players)
        self._dense_scale = self._alpha ** self._annealing_episode
        obs = self._obs()
        mask = compute_action_mask(self._state, slot=0)
        return obs, {'action_mask': mask}

    def step(self, action: int):
        assert self._state is not None
        # Build inputs: agent = action; opponents = random safe action
        inputs = [_ACTION_MAP[int(action)]]
        for opp_slot in range(1, self.num_players):
            opp_mask = compute_action_mask(self._state, slot=opp_slot)
            safe = [i for i, ok in enumerate(opp_mask) if ok]
            opp_action = int(self._rng.choice(safe)) if safe else 0
            inputs.append(_ACTION_MAP[opp_action])

        prev_state = self._state
        self._state = tick(self._state, inputs)

        reward = self._reward(prev_state, self._state, int(action))
        terminated = self._state['phase'] == PHASE_OVER
        truncated = self._state['tick'] >= MATCH_MAX_TICKS
        obs = self._obs()
        mask = compute_action_mask(self._state, slot=0)

        if terminated:
            self._annealing_episode += 1

        return obs, reward, terminated, truncated, {'action_mask': mask}

    def _obs(self):
        grid, scalars = encode_state(self._state, slot=0)
        return {'grid': grid, 'scalars': scalars}

    def _reward(self, prev: dict, curr: dict, action: int) -> float:
        dense = 0.0
        agent = next((p for p in curr['players'] if p['slot'] == 0), None)
        prev_agent = next((p for p in prev['players'] if p['slot'] == 0), None)

        # Agent dead
        if agent is None or not agent['alive']:
            if curr['phase'] == PHASE_OVER:
                alive_teams = {p['team'] for p in curr['players'] if p['alive']}
                if 0 not in alive_teams:
                    return -100.0 + self._dense_scale * dense
            return -100.0

        # Win
        alive_teams = {p['team'] for p in curr['players'] if p['alive']}
        if curr['phase'] == PHASE_OVER and len(alive_teams) <= 1 and 0 in alive_teams:
            return 100.0 + self._dense_scale * dense

        # Enemy eliminated this tick
        prev_alive_enemies = sum(1 for p in prev['players'] if p['alive'] and p['slot'] != 0)
        curr_alive_enemies = sum(1 for p in curr['players'] if p['alive'] and p['slot'] != 0)
        if curr_alive_enemies < prev_alive_enemies:
            dense += 30.0 * (prev_alive_enemies - curr_alive_enemies)

        # Items collected
        if prev_agent and agent:
            item_gain = (
                (agent['fire'] - prev_agent['fire']) +
                (agent['cannon'] - prev_agent['cannon']) +
                max(0, agent['speed_bonus_tenths'] - prev_agent['speed_bonus_tenths']) // 10
            )
            dense += 4.0 * item_gain

        # Movement
        if action == 0:
            dense -= 0.05
        else:
            moved = (
                agent['pos_x'] != prev_agent['pos_x'] or
                agent['pos_y'] != prev_agent['pos_y']
            ) if prev_agent else False
            if not moved:
                dense -= 0.2

        return self._dense_scale * dense
