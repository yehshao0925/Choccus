# rl/train/ppo_train.py
"""
PPO training with RecurrentPPO (sb3-contrib) + ChoccusCNNExtractor.
Loads BC-pretrained extractor weights as initialization.

Usage:
  rl/.venv/bin/python -m rl.train.ppo_train \
    --map classic \
    --bc rl/checkpoints/bc_extractor_classic.pt \
    --steps 10000000 --envs 4
"""
import argparse
import math
from pathlib import Path

import torch
from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv, VecMonitor
from stable_baselines3.common.callbacks import CheckpointCallback
from sb3_contrib import RecurrentPPO

from rl.env.choccus_env import ChoccusEnv
from rl.train.network import ChoccusCNNExtractor


def make_env(map_kind: str = 'classic', num_opponents: int = 1):
    def _init():
        return ChoccusEnv(map_kind=map_kind, num_opponents=num_opponents)
    return _init


def _cosine_lr(progress_remaining: float) -> float:
    """Cosine decay: 3e-4 at start → 1e-5 at end."""
    cos = 0.5 * (1.0 + math.cos(math.pi * (1.0 - progress_remaining)))
    return 1e-5 + (3e-4 - 1e-5) * cos


def make_ppo_model(vec_env, n_steps: int = 512, batch_size: int = 128, verbose: int = 1):
    return RecurrentPPO(
        policy="MultiInputLstmPolicy",
        env=vec_env,
        learning_rate=_cosine_lr,
        n_steps=n_steps,
        batch_size=batch_size,
        n_epochs=4,
        gamma=0.995,
        gae_lambda=0.95,
        clip_range=0.2,
        ent_coef=0.01,  # RecurrentPPO 2.9.0 does not support callable ent_coef
        verbose=verbose,
        policy_kwargs={
            "features_extractor_class": ChoccusCNNExtractor,
            "features_extractor_kwargs": {"features_dim": 512},
            "lstm_hidden_size": 256,
            "n_lstm_layers": 1,
            "net_arch": [],
        },
    )


def train_ppo(
    map_kind: str = 'classic',
    n_envs: int = 4,
    total_timesteps: int = 10_000_000,
    bc_checkpoint: str | None = None,
    save_dir: str = 'rl/checkpoints',
    checkpoint_freq: int = 100_000,
):
    Path(save_dir).mkdir(parents=True, exist_ok=True)

    if n_envs > 1:
        vec_env = SubprocVecEnv([make_env(map_kind) for _ in range(n_envs)])
    else:
        vec_env = DummyVecEnv([make_env(map_kind)])
    vec_env = VecMonitor(vec_env)

    model = make_ppo_model(vec_env)

    if bc_checkpoint and Path(bc_checkpoint).exists():
        state = torch.load(bc_checkpoint, map_location='cpu', weights_only=True)
        model.policy.features_extractor.load_state_dict(state)
        print(f"Loaded BC weights from {bc_checkpoint}")

    ckpt_cb = CheckpointCallback(
        save_freq=checkpoint_freq // n_envs,
        save_path=save_dir,
        name_prefix=f'rl_{map_kind}',
    )

    print(f"Training on {map_kind} with {n_envs} envs for {total_timesteps:,} steps")
    model.learn(total_timesteps=total_timesteps, callback=ckpt_cb)

    final_path = f"{save_dir}/final_{map_kind}"
    model.save(final_path)
    print(f"Saved final model to {final_path}.zip")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--map',   default='classic')
    parser.add_argument('--envs',  type=int,   default=4)
    parser.add_argument('--steps', type=int,   default=10_000_000)
    parser.add_argument('--bc',    default=None)
    parser.add_argument('--save',  default='rl/checkpoints')
    parser.add_argument('--freq',  type=int,   default=100_000)
    args = parser.parse_args()
    train_ppo(args.map, args.envs, args.steps, args.bc, args.save, args.freq)
