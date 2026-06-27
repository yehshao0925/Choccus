# rl/eval/bc_play.py
"""
BC policy（extractor + head）vs 隨機對手，統計勝率。

Usage:
  rl/.venv/bin/python -m rl.eval.bc_play \
    --ckpt rl/checkpoints/bc_extractor_classic_ep4_full.pt \
    --map classic --games 100
"""
import argparse
import random

import numpy as np
import torch
import torch.nn as nn
from gymnasium import spaces

from rl.env.constants import MAP_ROWS, MAP_COLS
from rl.env.sim import create_initial_state, tick
from rl.env.state_encoder import encode_state
from rl.env.types import (
    ACTION_BOMB, DIR_DOWN, DIR_LEFT, DIR_NONE, DIR_RIGHT, DIR_UP,
    InputFrame, PHASE_PLAYING,
)
from rl.train.network import ChoccusCNNExtractor

_IDX_TO_INPUT = [
    InputFrame(dir=DIR_NONE,  action=0),
    InputFrame(dir=DIR_UP,    action=0),
    InputFrame(dir=DIR_DOWN,  action=0),
    InputFrame(dir=DIR_LEFT,  action=0),
    InputFrame(dir=DIR_RIGHT, action=0),
    InputFrame(dir=DIR_NONE,  action=ACTION_BOMB),
]

_ACTION_NAMES = ['stay', 'up', 'down', 'left', 'right', 'bomb']


def load_policy(ckpt_path: str, device: str):
    obs_space = spaces.Dict({
        'grid':    spaces.Box(-1.0, 1.0, (MAP_ROWS, MAP_COLS, 12), np.float32),
        'scalars': spaces.Box(-1.0, 1.0, (9,), np.float32),
    })
    raw = torch.load(ckpt_path, map_location=device)
    features_dim = raw.get('features_dim', 512)
    extractor = ChoccusCNNExtractor(obs_space, features_dim=features_dim).to(device)
    extractor.load_state_dict(raw['extractor'])
    head = nn.Linear(features_dim, 6).to(device)
    head.load_state_dict(raw['head'])
    extractor.eval()
    head.eval()
    return extractor, head


@torch.no_grad()
def bc_step(extractor, head, state: dict, slot: int, device: str) -> InputFrame:
    grid, scalars = encode_state(state, slot)
    g = torch.from_numpy(grid.copy()).unsqueeze(0).to(device)
    s = torch.from_numpy(scalars.copy()).unsqueeze(0).to(device)
    feats = extractor({'grid': g, 'scalars': s})
    idx = head(feats).argmax(1).item()
    return _IDX_TO_INPUT[idx]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--ckpt',  required=True)
    parser.add_argument('--map',   default='classic')
    parser.add_argument('--games', type=int, default=100)
    parser.add_argument('--seed',  type=int, default=0)
    args = parser.parse_args()

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f"裝置: {device}  |  地圖: {args.map}  |  場數: {args.games}")
    extractor, head = load_policy(args.ckpt, device)
    print(f"載入: {args.ckpt}")
    print()

    wins = draws = losses = 0
    tick_counts: list[int] = []

    for g in range(args.games):
        seed = args.seed + g
        state = create_initial_state(seed=seed, map_kind=args.map, num_players=2)

        while state['phase'] == PHASE_PLAYING:
            bc_inp  = bc_step(extractor, head, state, slot=0, device=device)
            rnd_inp = _IDX_TO_INPUT[random.randint(0, 5)]
            state   = tick(state, [bc_inp, rnd_inp])

        bc_alive  = state['players'][0]['alive']
        rnd_alive = state['players'][1]['alive']
        tick_counts.append(state['tick'])

        if bc_alive and not rnd_alive:
            wins += 1
        elif not bc_alive and rnd_alive:
            losses += 1
        else:
            draws += 1

        if (g + 1) % 20 == 0:
            print(f"  進度 {g+1:3d}/{args.games}  勝={wins} 平={draws} 負={losses}")

    n = args.games
    avg_t = sum(tick_counts) / n
    print()
    print(f"=== BC ep vs 隨機 ({args.map}, {n} 場) ===")
    print(f"  勝  {wins:3d}  ({wins/n*100:.1f}%)")
    print(f"  平  {draws:3d}  ({draws/n*100:.1f}%)")
    print(f"  負  {losses:3d}  ({losses/n*100:.1f}%)")
    print(f"  平均對局長度: {avg_t:.0f} ticks ({avg_t/60:.1f} 秒)")


if __name__ == '__main__':
    main()
